import { Router, type Request } from 'express';
import { HttpError, requireString } from '../lib/http.js';
import { readToken } from '../lib/tokens.js';
import { POSE_TEXT, positionNames } from '../services/copresence-rules.js';
import {
  finishClaimLiveness,
  issueChallenge,
  livenessStatus,
  startClaimLiveness,
  submitJointCapture,
  type Role,
} from '../services/copresence.js';
import { issueToken } from '../lib/tokens.js';

/**
 * Co-presence runs on ONE device (the claimant's), with both people in
 * front of it. Every call carries the claim token.
 */
export const copresenceRouter = Router();

const SESSION_TTL = 12 * 60 * 60;

function claimFromToken(req: Request): string {
  const id = String(req.params.id);
  const claimId = readToken<{ claimId: string }>(req.get('x-claim-token'), 'claim').claimId;
  if (claimId !== id) throw new HttpError(403, 'wrong_claim', 'Token is for another claim');
  return id;
}

function role(body: unknown): Role {
  const r = requireString(body, 'role');
  if (r !== 'owner' && r !== 'claimant') throw new HttpError(400, 'bad_request', 'role must be owner or claimant');
  return r;
}

copresenceRouter.get('/claims/:id/liveness', async (req, res) => {
  res.json({ liveness: await livenessStatus(claimFromToken(req)) });
});

copresenceRouter.post('/claims/:id/liveness-session', async (req, res) => {
  const id = claimFromToken(req);
  res.json({ sessionId: await startClaimLiveness(id, role(req.body)) });
});

copresenceRouter.post('/claims/:id/liveness', async (req, res) => {
  const id = claimFromToken(req);
  const out = await finishClaimLiveness(id, role(req.body), requireString(req.body, 'sessionId'));
  res.json({ state: out.claim.state, liveness: out.liveness });
});

copresenceRouter.post('/claims/:id/challenge', async (req, res) => {
  const { challenge, expiresAt } = await issueChallenge(claimFromToken(req));
  const names = positionNames(challenge.slots.length);
  res.json({
    expiresAt,
    claimantSlot: challenge.claimantSlot,
    slots: challenge.slots.map((pose, i) => ({
      position: names[i],
      pose,
      instruction: POSE_TEXT[pose],
      role: i === challenge.claimantSlot ? 'claimant' : 'owner',
    })),
  });
});

/** Body: { image: "<base64 jpeg>" } (a data URL prefix is fine). */
copresenceRouter.post('/claims/:id/joint-capture', async (req, res) => {
  const id = claimFromToken(req);
  const raw = requireString(req.body, 'image', 8_000_000).replace(/^data:image\/\w+;base64,/, '');
  const image = Buffer.from(raw, 'base64');
  if (image.length < 1000) throw new HttpError(400, 'bad_image', 'Image is empty or not base64');

  const out = await submitJointCapture(id, image);
  const faces = out.faces.map((f) => ({
    position: f.position,
    role: f.role,
    expectedPose: f.expectedPose,
    pose: {
      yaw: Math.round(f.pose.yaw),
      roll: Math.round(f.pose.roll),
      pitch: Math.round(f.pose.pitch),
    },
    poseOk: f.poseOk,
    similarity: f.matches[0] ? Math.round(f.matches[0].similarity * 10) / 10 : null,
    identityOk: f.identityOk,
    boxWidth: Math.round(f.box.width * 100) / 100,
  }));

  if (out.result === 'pass') {
    res.json({
      result: 'pass',
      state: out.claim.state,
      identity: out.identity,
      recoveryCode: out.recoveryCode, // shown ONCE, to the claimant
      sessionToken: issueToken('session', { sub: out.identity.id }, SESSION_TTL),
      faces,
    });
    return;
  }
  res.json({ result: 'fail', state: out.claim.state, reasons: out.reasons, attemptsLeft: out.attemptsLeft, faces });
});
