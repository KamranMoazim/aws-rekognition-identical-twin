import { Router, type Request } from 'express';
import { HttpError, requireString } from '../lib/http.js';
import { issueToken, readToken } from '../lib/tokens.js';
import {
  ACTIVE_STATES,
  activeClaimsAgainst,
  claimByResumeCode,
  confirmAsMember,
  confirmations,
  getClaim,
  isClaimOwner,
  move,
  nextStep,
  openClaim,
  type Claim,
} from '../services/claims.js';
import { verifyRecoveryCode } from '../services/identities.js';
import { currentIdentityId } from './auth.js';

export const claimsRouter = Router();

const CLAIM_TOKEN_TTL = 24 * 60 * 60;

/** What either party may see. No identity ids of the other person. */
async function view(claim: Claim, viewerId?: string) {
  const conf = await confirmations(claim);
  return {
    id: claim.id,
    state: claim.state,
    claimantName: claim.claimantName,
    nextStep: nextStep(claim.state),
    expiresAt: claim.expiresAt,
    createdAt: claim.createdAt,
    ownerConfirmedAt: claim.ownerConfirmedAt,
    reviewReason: claim.reviewReason,
    closedAt: claim.closedAt,
    attemptCount: claim.attemptCount,
    owners: {
      required: conf.required.length,
      confirmed: conf.confirmed.length,
      ...(viewerId ? { youConfirmed: conf.confirmed.includes(viewerId) } : {}),
    },
  };
}

/** The claimant has no account yet; they hold a claim token (header X-Claim-Token). */
function claimantClaimId(req: Request): string {
  return readToken<{ claimId: string }>(req.get('x-claim-token'), 'claim').claimId;
}

/** Owner = a logged-in member of the target (one identity, or every member of its group). */
async function ownedClaim(req: Request): Promise<{ claim: Claim; identityId: string }> {
  const identityId = currentIdentityId(req);
  const claim = await getClaim(String(req.params.id));
  if (!(await isClaimOwner(claim, identityId))) throw new HttpError(403, 'not_owner', 'This claim is not against your identity');
  return { claim, identityId };
}

// B: "this is not my account". Needs the match token from a failed registration.
claimsRouter.post('/claims', async (req, res) => {
  const matchToken = requireString(req.body, 'matchToken', 4000);
  const claimantName = requireString(req.body, 'claimantName', 80);
  const { identityIds } = readToken<{ identityIds: string[] }>(matchToken, 'match');
  const { claim, resumeCode } = await openClaim(identityIds, claimantName);
  res.status(201).json({
    claim: await view(claim),
    claimToken: issueToken('claim', { claimId: claim.id }, CLAIM_TOKEN_TTL),
    resumeCode, // shown ONCE: continue this claim on another device
  });
});

// Claimant continues on another device/browser with the resume code.
claimsRouter.post('/claims/resume', async (req, res) => {
  const claim = await claimByResumeCode(requireString(req.body, 'resumeCode', 40));
  res.json({ claim: await view(claim), claimToken: issueToken('claim', { claimId: claim.id }, CLAIM_TOKEN_TTL) });
});

// Either party checks status: claimant via claim token, owner via session.
claimsRouter.get('/claims/:id', async (req, res) => {
  const id = String(req.params.id);
  if (req.get('x-claim-token')) {
    if (claimantClaimId(req) !== id) throw new HttpError(403, 'wrong_claim', 'Token is for another claim');
    res.json({ claim: await view(await getClaim(id)), role: 'claimant' });
    return;
  }
  const { claim, identityId } = await ownedClaim(req);
  res.json({ claim: await view(claim, identityId), role: 'owner' });
});

// Claimant gives up. Nothing changes for the owner.
claimsRouter.delete('/claims/:id', async (req, res) => {
  const id = String(req.params.id);
  if (claimantClaimId(req) !== id) throw new HttpError(403, 'wrong_claim', 'Token is for another claim');
  const claim = await move(id, [...ACTIVE_STATES], 'cancelled', { auditType: 'claim.cancelled' });
  res.json({ claim: await view(claim) });
});

// Owner: claims against me (or my group) that still need something.
claimsRouter.get('/me/claims', async (req, res) => {
  const me = currentIdentityId(req);
  const claims = await activeClaimsAgainst(me);
  res.json({ claims: await Promise.all(claims.map((c) => view(c, me))) });
});

/**
 * A member confirms they are taking part. A lookalike can log in to a
 * member's account by face, so the recovery code (something only that member
 * holds) is what proves the real member is here. Every member must confirm.
 */
claimsRouter.post('/claims/:id/owner-confirm', async (req, res) => {
  const { claim, identityId } = await ownedClaim(req);
  const code = requireString(req.body, 'recoveryCode', 40);
  if (claim.state !== 'open') throw new HttpError(409, 'bad_claim_state', `Claim is ${claim.state}`);
  if ((await confirmations(claim)).confirmed.includes(identityId)) {
    throw new HttpError(409, 'already_confirmed', 'You already confirmed this claim.');
  }
  await verifyRecoveryCode(identityId, code);
  const updated = await confirmAsMember(claim.id, identityId);
  res.json({ claim: await view(updated, identityId) });
});

/**
 * Owner withdraws a claim that is already past "open" (e.g. the claimant lost
 * their claim token). Harmless if a lookalike does it from the owner's
 * account: it only hurts the lookalike's own claim.
 */
claimsRouter.post('/claims/:id/owner-cancel', async (req, res) => {
  const { claim, identityId } = await ownedClaim(req);
  const updated = await move(claim.id, [...ACTIVE_STATES], 'cancelled', {
    auditType: 'claim.owner_cancelled',
    auditData: { by: identityId },
  });
  res.json({ claim: await view(updated, identityId) });
});

/** A member refuses to take part. Cannot be proven automatically, so a human decides. */
claimsRouter.post('/claims/:id/owner-decline', async (req, res) => {
  const { claim, identityId } = await ownedClaim(req);
  const updated = await move(claim.id, ['open'], 'review', {
    reviewReason: 'owner_declined',
    auditType: 'claim.owner_declined',
    auditData: { by: identityId },
  });
  res.json({ claim: await view(updated, identityId) });
});
