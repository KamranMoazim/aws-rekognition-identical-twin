import { randomUUID } from 'node:crypto';
import { DetectFacesCommand } from '@aws-sdk/client-rekognition';
import sharp from 'sharp';
import { rekognition } from '../aws.js';
import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { hashSecret, newRecoveryCode } from '../lib/secrets.js';
import { getClaim, move, transition, type Claim } from './claims.js';
import { checkFrame, cropRect, newChallenge, type Challenge, type DetectedFace, type FaceCheck } from './copresence-rules.js';
import { deleteFaces, indexFace, searchByImage, type IdentityMatch } from './faces.js';
import { getIdentity, type Identity } from './identities.js';
import { consumeLiveness, createLivenessSession } from './liveness.js';

export type Role = 'owner' | 'claimant';

const LIVE_WINDOW_MINUTES = 10; // both liveness checks must be this fresh when the challenge starts
const CHALLENGE_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/** Which roles have a passed liveness session for this claim, within the window. */
export async function livenessStatus(claimId: string): Promise<Record<Role, boolean>> {
  const r = await pool.query<{ role: Role }>(
    `select distinct role from liveness_sessions
      where claim_id = $1 and passed and created_at > now() - make_interval(mins => $2)`,
    [claimId, LIVE_WINDOW_MINUTES],
  );
  const roles = new Set(r.rows.map((x) => x.role));
  return { owner: roles.has('owner'), claimant: roles.has('claimant') };
}

export async function startClaimLiveness(claimId: string, role: Role): Promise<string> {
  const claim = await getClaim(claimId);
  if (!['owner_confirmed', 'both_live'].includes(claim.state)) {
    throw new HttpError(409, 'bad_claim_state', `Liveness is not expected in state ${claim.state}`);
  }
  return createLivenessSession('claim', { claimId, role });
}

/**
 * Spend a claim liveness session. The live face must match the claimed
 * identity (both twins do). When both roles have passed, the claim moves
 * to both_live.
 */
export async function finishClaimLiveness(claimId: string, role: Role, sessionId: string) {
  const claim = await getClaim(claimId);
  if (!['owner_confirmed', 'both_live'].includes(claim.state)) {
    throw new HttpError(409, 'bad_claim_state', `Liveness is not expected in state ${claim.state}`);
  }
  const { bytes, confidence } = await consumeLiveness(sessionId, 'claim', { claimId, role });
  const matches = await searchByImage(bytes);
  const matchesTarget = matches.some((m) => m.identityId === claim.targetIdentityId);
  const others = matches.filter((m) => m.identityId !== claim.targetIdentityId);
  if (!matchesTarget || others.length) {
    await audit('claim.liveness_rejected', { claimId, data: { role, matches } });
    throw new HttpError(
      422,
      'face_not_target',
      matchesTarget
        ? 'This face also matches another identity.'
        : 'This face does not match the identity in the claim. Both people must look like the account owner.',
    );
  }
  await pool.query('update liveness_sessions set passed = true where session_id = $1', [sessionId]);
  await audit('claim.liveness_passed', { claimId, data: { role, confidence, similarity: matches[0]?.similarity } });

  const status = await livenessStatus(claimId);
  let current: Claim = claim;
  if (status.owner && status.claimant && claim.state === 'owner_confirmed') {
    current = (await transition(claimId, ['owner_confirmed'], 'both_live', { auditType: 'claim.both_live' })).claim;
  }
  return { claim: current, liveness: status };
}

/** Issue a fresh random challenge (single use, 60 s). Needs both liveness checks still fresh. */
export async function issueChallenge(claimId: string): Promise<{ claim: Claim; challenge: Challenge; expiresAt: string }> {
  const claim = await getClaim(claimId);
  if (!['both_live', 'challenged'].includes(claim.state)) {
    throw new HttpError(409, 'bad_claim_state', `Cannot start the joint check in state ${claim.state}`);
  }
  const status = await livenessStatus(claimId);
  if (!status.owner || !status.claimant) {
    // Too long since the liveness checks: do them again.
    await transition(claimId, ['both_live', 'challenged'], 'owner_confirmed', { auditType: 'claim.liveness_stale' });
    throw new HttpError(409, 'liveness_stale', `Liveness checks are older than ${LIVE_WINDOW_MINUTES} minutes. Both people must redo them.`);
  }
  const challenge = newChallenge();
  const updated = await move(claimId, ['both_live', 'challenged'], 'challenged', {
    auditType: 'claim.challenge_issued',
    auditData: challenge,
    also: async (c) => {
      await c.query(
        `update claims set challenge = $2, challenge_expires_at = now() + make_interval(secs => $3) where id = $1`,
        [claimId, JSON.stringify(challenge), CHALLENGE_SECONDS],
      );
    },
  });
  const exp = await pool.query<{ challenge_expires_at: string }>('select challenge_expires_at from claims where id = $1', [claimId]);
  return { claim: updated, challenge, expiresAt: exp.rows[0]!.challenge_expires_at };
}

export type FaceReport = FaceCheck & { matches: IdentityMatch[]; identityOk: boolean };

export type JointResult =
  | { result: 'pass'; claim: Claim; identity: Identity; recoveryCode: string; faces: FaceReport[] }
  | { result: 'fail'; claim: Claim; reasons: string[]; attemptsLeft: number; faces: FaceReport[] };

/**
 * The co-presence proof. One person cannot be two live faces in one frame,
 * each following its own random instruction.
 */
export async function submitJointCapture(claimId: string, image: Buffer): Promise<JointResult> {
  // 1. Spend the challenge atomically: one capture per challenge, and only before it expires.
  const spent = await pool.query<{ challenge: Challenge; target_identity_id: string }>(
    `with old as (
       select id, challenge from claims
        where id = $1 and state = 'challenged' and challenge is not null and challenge_expires_at > now()
        for update
     )
     update claims c set challenge = null, updated_at = now()
       from old where c.id = old.id
     returning old.challenge, c.target_identity_id`,
    [claimId],
  );
  if (!spent.rowCount) {
    const claim = await getClaim(claimId);
    if (claim.state !== 'challenged') throw new HttpError(409, 'bad_claim_state', `Claim is ${claim.state}`);
    throw new HttpError(410, 'challenge_expired', 'No active challenge (expired or already used). Start the joint check again.');
  }
  const { challenge, target_identity_id: targetId } = spent.rows[0]!;

  // 2. Geometry and pose.
  const detected = await detectFaces(image);
  const frame = checkFrame(detected, challenge);
  let faces: FaceReport[] = frame.faces.map((f) => ({ ...f, matches: [], identityOk: false }));
  const reasons = frame.ok ? [] : [...frame.reasons];

  // 3. Identity: each face, cropped and searched alone, must match the owner and nobody else.
  let claimantCrop: Buffer | null = null;
  if (frame.faces.length === 2) {
    const meta = await sharp(image).metadata();
    faces = await Promise.all(
      frame.faces.map(async (f) => {
        const crop = await sharp(image).extract(cropRect(f.box, meta.width!, meta.height!)).jpeg().toBuffer();
        if (f.role === 'claimant') claimantCrop = crop;
        let matches: IdentityMatch[] = [];
        try {
          matches = await searchByImage(crop);
        } catch {
          matches = [];
        }
        const identityOk = matches.length > 0 && matches.every((m) => m.identityId === targetId);
        return { ...f, matches, identityOk };
      }),
    );
    for (const f of faces) {
      if (!f.identityOk) {
        reasons.push(
          f.matches.length
            ? `The ${f.side} face matches a different identity.`
            : `The ${f.side} face does not match the account owner.`,
        );
      }
    }
  }

  const summary = faces.map((f) => ({
    side: f.side,
    role: f.role,
    expectedPose: f.expectedPose,
    pose: f.pose,
    poseOk: f.poseOk,
    similarity: f.matches[0]?.similarity,
    identityOk: f.identityOk,
  }));

  if (reasons.length || !claimantCrop) return failAttempt(claimId, reasons, faces, summary);
  return resolveClaim(claimId, claimantCrop, faces, summary);
}

async function detectFaces(image: Buffer): Promise<DetectedFace[]> {
  const out = await rekognition.send(new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['DEFAULT'] }));
  return (out.FaceDetails ?? []).map((f) => ({
    confidence: f.Confidence ?? 0,
    box: {
      left: f.BoundingBox?.Left ?? 0,
      top: f.BoundingBox?.Top ?? 0,
      width: f.BoundingBox?.Width ?? 0,
      height: f.BoundingBox?.Height ?? 0,
    },
    pose: { yaw: f.Pose?.Yaw ?? 0, roll: f.Pose?.Roll ?? 0, pitch: f.Pose?.Pitch ?? 0 },
  }));
}

async function failAttempt(claimId: string, reasons: string[], faces: FaceReport[], summary: unknown): Promise<JointResult> {
  const r = await pool.query<{ attempt_count: number }>(
    'update claims set attempt_count = attempt_count + 1 where id = $1 returning attempt_count',
    [claimId],
  );
  const attempts = r.rows[0]!.attempt_count;
  const data = { reasons, faces: summary, attempt: attempts };
  const claim =
    attempts >= MAX_ATTEMPTS
      ? (await transition(claimId, ['challenged'], 'review', {
          reviewReason: 'co_presence_failed',
          auditType: 'claim.co_presence_failed_final',
          auditData: data,
        })).claim
      : (await transition(claimId, ['challenged'], 'both_live', { auditType: 'claim.co_presence_failed', auditData: data })).claim;
  return { result: 'fail', claim, reasons, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), faces };
}

/**
 * Pass: the claimant gets their own identity (face indexed from the joint
 * frame) and both identities join one collision group. From now on a face
 * match only picks the group; the PIN picks the person (step 5).
 */
async function resolveClaim(claimId: string, claimantCrop: Buffer, faces: FaceReport[], summary: unknown): Promise<JointResult> {
  const before = await getClaim(claimId);
  const newId = randomUUID();
  const faceId = await indexFace(claimantCrop, newId);
  const recoveryCode = newRecoveryCode();
  const recoveryHash = await hashSecret(recoveryCode);

  let claim: Claim;
  try {
    claim = await move(claimId, ['challenged'], 'resolved', {
      auditType: 'claim.resolved',
      auditData: { faces: summary, newIdentityId: newId },
      also: async (c) => {
        await c.query('insert into identities (id, display_name) values ($1, $2)', [newId, before.claimantName]);
        await c.query(`insert into faces (rekognition_face_id, identity_id, source) values ($1, $2, 'co_presence')`, [faceId, newId]);
        await c.query('insert into credentials (identity_id, recovery_code_hash) values ($1, $2)', [newId, recoveryHash]);
        // Target is never in a group here (openClaim refuses that), so always a new group.
        const group = await c.query<{ id: string }>('insert into collision_groups default values returning id');
        const groupId = group.rows[0]!.id;
        await c.query('insert into group_members (identity_id, group_id) values ($1, $3), ($2, $3)', [
          before.targetIdentityId,
          newId,
          groupId,
        ]);
        await c.query('update claims set result_identity_id = $2 where id = $1', [claimId, newId]);
        await audit('identity.created', { identityId: newId, claimId, data: { faceId, groupId, via: 'co_presence' } }, c);
      },
    });
  } catch (err) {
    await deleteFaces([faceId]);
    throw err;
  }
  return { result: 'pass', claim, identity: await getIdentity(newId), recoveryCode, faces };
}
