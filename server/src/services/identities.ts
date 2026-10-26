import { randomUUID } from 'node:crypto';
import { pool, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { hashSecret, newRecoveryCode, verifySecret } from '../lib/secrets.js';
import { deleteFaces, indexFace, searchByFaceId, type IdentityMatch } from './faces.js';

export type Identity = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  groupId: string | null;
};

export async function getIdentity(id: string): Promise<Identity> {
  const r = await pool.query(
    `select i.id, i.display_name, i.status, i.created_at, gm.group_id
       from identities i left join group_members gm on gm.identity_id = i.id
      where i.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'identity_not_found', 'Identity not found');
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    groupId: row.group_id,
  };
}

/** Group ids for any of these identities (empty = none are in a collision group). */
export async function groupsOf(identityIds: string[]): Promise<string[]> {
  const r = await pool.query<{ group_id: string }>(
    'select distinct group_id from group_members where identity_id = any($1)',
    [identityIds],
  );
  return r.rows.map((x) => x.group_id);
}

export type RegisterOutcome =
  | { kind: 'created'; identity: Identity; recoveryCode: string }
  | { kind: 'race_match'; matches: IdentityMatch[] };

/**
 * Create a brand-new identity for a face nobody else matches.
 * Index first, then re-check by FaceId: if two lookalikes register at the
 * same moment, both see each other here and both back out (fail safe).
 */
export async function createIdentity(displayName: string, faceBytes: Uint8Array): Promise<RegisterOutcome> {
  const identityId = randomUUID();
  const faceId = await indexFace(faceBytes, identityId);

  const lateMatches = await searchByFaceId(faceId);
  if (lateMatches.length) {
    await deleteFaces([faceId]);
    return { kind: 'race_match', matches: lateMatches };
  }

  const recoveryCode = newRecoveryCode();
  const recoveryHash = await hashSecret(recoveryCode);
  try {
    await tx(async (c) => {
      await c.query('insert into identities (id, display_name) values ($1, $2)', [identityId, displayName]);
      await c.query(
        `insert into faces (rekognition_face_id, identity_id, source) values ($1, $2, 'registration')`,
        [faceId, identityId],
      );
      await c.query('insert into credentials (identity_id, recovery_code_hash) values ($1, $2)', [
        identityId,
        recoveryHash,
      ]);
      await audit('identity.created', { identityId, data: { faceId } }, c);
    });
  } catch (err) {
    await deleteFaces([faceId]); // keep Rekognition and Postgres in step
    throw err;
  }
  return { kind: 'created', identity: await getIdentity(identityId), recoveryCode };
}

const MAX_CODE_FAILS = 5;
const CODE_LOCK_MINUTES = 15;

/**
 * Check an identity's recovery code with a per-identity lockout.
 * The counter update must commit even when the code is wrong, so the
 * transaction returns a verdict and we throw only after it commits.
 */
export async function verifyRecoveryCode(identityId: string, code: string): Promise<void> {
  const verdict = await tx(async (c) => {
    const row = (
      await c.query(
        `select recovery_code_hash, failed_attempts, locked_until > now() as locked
           from credentials where identity_id = $1 for update`,
        [identityId],
      )
    ).rows[0];
    if (!row) return { ok: false as const, reason: 'no_credentials' as const };
    if (row.locked) return { ok: false as const, reason: 'locked' as const };

    if (await verifySecret(code.trim().toUpperCase(), row.recovery_code_hash)) {
      await c.query('update credentials set failed_attempts = 0, locked_until = null where identity_id = $1', [identityId]);
      return { ok: true as const };
    }

    const fails = row.failed_attempts + 1;
    if (fails >= MAX_CODE_FAILS) {
      await c.query(
        `update credentials set failed_attempts = 0,
                locked_until = now() + make_interval(mins => $2) where identity_id = $1`,
        [identityId, CODE_LOCK_MINUTES],
      );
      await audit('recovery_code.locked', { identityId }, c);
      return { ok: false as const, reason: 'locked' as const };
    }
    await c.query('update credentials set failed_attempts = $2 where identity_id = $1', [identityId, fails]);
    return { ok: false as const, reason: 'wrong' as const, attemptsLeft: MAX_CODE_FAILS - fails };
  });

  if (verdict.ok) return;
  if (verdict.reason === 'locked') {
    throw new HttpError(423, 'code_locked', `Too many wrong codes. Try again in ${CODE_LOCK_MINUTES} minutes.`);
  }
  if (verdict.reason === 'no_credentials') throw new HttpError(404, 'no_credentials', 'No credentials for identity');
  throw new HttpError(403, 'wrong_code', 'Recovery code is wrong', { attemptsLeft: verdict.attemptsLeft });
}
