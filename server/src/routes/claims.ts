import { Router, type Request } from 'express';
import { HttpError, requireString } from '../lib/http.js';
import { issueToken, readToken } from '../lib/tokens.js';
import { ACTIVE_STATES, activeClaimsAgainst, getClaim, move, nextStep, openClaim, type Claim } from '../services/claims.js';
import { verifyRecoveryCode } from '../services/identities.js';
import { currentIdentityId } from './auth.js';

export const claimsRouter = Router();

const CLAIM_TOKEN_TTL = 24 * 60 * 60;

/** What either party may see. No identity ids of the other person. */
function view(claim: Claim) {
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
  };
}

/** The claimant has no account yet; they hold a claim token (header X-Claim-Token). */
function claimantClaimId(req: Request): string {
  return readToken<{ claimId: string }>(req.get('x-claim-token'), 'claim').claimId;
}

/** Owner = whoever is logged in to the target identity. Face login alone is not enough to confirm. */
async function ownedClaim(req: Request): Promise<Claim> {
  const identityId = currentIdentityId(req);
  const claim = await getClaim(String(req.params.id));
  if (claim.targetIdentityId !== identityId) throw new HttpError(403, 'not_owner', 'This claim is not against your identity');
  return claim;
}

// B: "this is not my account". Needs the match token from a failed registration.
claimsRouter.post('/claims', async (req, res) => {
  const matchToken = requireString(req.body, 'matchToken', 4000);
  const claimantName = requireString(req.body, 'claimantName', 80);
  const { identityIds } = readToken<{ identityIds: string[] }>(matchToken, 'match');
  const claim = await openClaim(identityIds, claimantName);
  res.status(201).json({
    claim: view(claim),
    claimToken: issueToken('claim', { claimId: claim.id }, CLAIM_TOKEN_TTL),
  });
});

// Either party checks status: claimant via claim token, owner via session.
claimsRouter.get('/claims/:id', async (req, res) => {
  const id = String(req.params.id);
  if (req.get('x-claim-token')) {
    if (claimantClaimId(req) !== id) throw new HttpError(403, 'wrong_claim', 'Token is for another claim');
    res.json({ claim: view(await getClaim(id)), role: 'claimant' });
    return;
  }
  res.json({ claim: view(await ownedClaim(req)), role: 'owner' });
});

// Claimant gives up. Nothing changes for the owner.
claimsRouter.delete('/claims/:id', async (req, res) => {
  const id = String(req.params.id);
  if (claimantClaimId(req) !== id) throw new HttpError(403, 'wrong_claim', 'Token is for another claim');
  const claim = await move(id, [...ACTIVE_STATES], 'cancelled', { auditType: 'claim.cancelled' });
  res.json({ claim: view(claim) });
});

// Owner: claims against me that still need something.
claimsRouter.get('/me/claims', async (req, res) => {
  const claims = await activeClaimsAgainst(currentIdentityId(req));
  res.json({ claims: claims.map(view) });
});

/**
 * Owner confirms they are taking part. A lookalike can log in to the owner's
 * account by face, so the recovery code (something only the owner holds) is
 * what proves the real owner is here.
 */
claimsRouter.post('/claims/:id/owner-confirm', async (req, res) => {
  const claim = await ownedClaim(req);
  const code = requireString(req.body, 'recoveryCode', 40);
  if (claim.state !== 'open') throw new HttpError(409, 'bad_claim_state', `Claim is ${claim.state}`);
  await verifyRecoveryCode(claim.targetIdentityId, code);
  const updated = await move(claim.id, ['open'], 'owner_confirmed', { auditType: 'claim.owner_confirmed' });
  res.json({ claim: view(updated) });
});

/**
 * Owner withdraws a claim that is already past "open" (e.g. the claimant lost
 * their claim token). Harmless if a lookalike does it from the owner's
 * account: it only hurts the lookalike's own claim.
 */
claimsRouter.post('/claims/:id/owner-cancel', async (req, res) => {
  const claim = await ownedClaim(req);
  const updated = await move(claim.id, [...ACTIVE_STATES], 'cancelled', {
    auditType: 'claim.owner_cancelled',
  });
  res.json({ claim: view(updated) });
});

/** Owner refuses to take part. Cannot be proven automatically, so a human decides. */
claimsRouter.post('/claims/:id/owner-decline', async (req, res) => {
  const claim = await ownedClaim(req);
  const updated = await move(claim.id, ['open'], 'review', {
    reviewReason: 'owner_declined',
    auditType: 'claim.owner_declined',
  });
  res.json({ claim: view(updated) });
});
