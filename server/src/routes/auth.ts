import { Router, type Request } from 'express';
import { audit } from '../lib/audit.js';
import { HttpError, requireString } from '../lib/http.js';
import { issueToken, readToken } from '../lib/tokens.js';
import { searchByImage, type IdentityMatch } from '../services/faces.js';
import { createIdentity, getIdentity, groupsOf } from '../services/identities.js';
import { consumeLiveness, createLivenessSession, type LivenessPurpose } from '../services/liveness.js';

export const authRouter = Router();

const SESSION_TTL = 12 * 60 * 60; // 12 h
const MATCH_TTL = 10 * 60; // 10 min to decide "this is not me"

/** Who is calling? Reads "Authorization: Bearer <session token>". */
export function currentIdentityId(req: Request): string {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  return readToken<{ sub: string }>(token, 'session').sub;
}

/**
 * A match token says "this live face matched these identities" without
 * revealing who they are. Step 3 uses it to open a claim.
 */
function matchResponse(matches: IdentityMatch[]) {
  return {
    status: 'match' as const,
    message: 'This face matches an existing identity.',
    matchToken: issueToken('match', { identityIds: matches.map((m) => m.identityId) }, MATCH_TTL),
    topSimilarity: Math.round(matches[0]!.similarity * 10) / 10,
  };
}

// Only these purposes can be started directly; claim/recovery sessions come later with their own checks.
const OPEN_PURPOSES: LivenessPurpose[] = ['register', 'login'];

authRouter.post('/liveness/sessions', async (req, res) => {
  const purpose = requireString(req.body, 'purpose') as LivenessPurpose;
  if (!OPEN_PURPOSES.includes(purpose)) throw new HttpError(400, 'bad_request', 'purpose must be register or login');
  res.json({ sessionId: await createLivenessSession(purpose) });
});

authRouter.post('/register', async (req, res) => {
  const sessionId = requireString(req.body, 'sessionId');
  const displayName = requireString(req.body, 'displayName', 80);
  const { bytes, confidence } = await consumeLiveness(sessionId, 'register');

  const matches = await searchByImage(bytes);
  if (matches.length) {
    await audit('register.matched', { data: { matches, confidence } });
    res.status(409).json(matchResponse(matches));
    return;
  }

  const outcome = await createIdentity(displayName, bytes);
  if (outcome.kind === 'race_match') {
    await audit('register.race_matched', { data: { matches: outcome.matches } });
    res.status(409).json(matchResponse(outcome.matches));
    return;
  }

  res.status(201).json({
    status: 'registered',
    identity: outcome.identity,
    recoveryCode: outcome.recoveryCode, // shown ONCE
    sessionToken: issueToken('session', { sub: outcome.identity.id }, SESSION_TTL),
    livenessConfidence: confidence,
  });
});

authRouter.post('/login', async (req, res) => {
  const sessionId = requireString(req.body, 'sessionId');
  const { bytes, confidence } = await consumeLiveness(sessionId, 'login');

  const matches = await searchByImage(bytes);
  if (!matches.length) {
    await audit('login.no_match', { data: { confidence } });
    throw new HttpError(404, 'no_match', 'No identity matches this face. Register first.');
  }

  const ids = matches.map((m) => m.identityId);
  const groups = await groupsOf(ids);
  if (groups.length) {
    // Face alone cannot pick between lookalikes. PIN step arrives in step 5.
    await audit('login.group_match', { data: { matches, groups } });
    throw new HttpError(409, 'pin_required', 'This face belongs to a collision group. PIN login is built in step 5.');
  }
  if (ids.length > 1) {
    // Two separate identities match and they never proved they are different people: never guess.
    await audit('login.ambiguous', { data: { matches } });
    throw new HttpError(409, 'ambiguous_match', 'This face matches more than one identity. Login refused.');
  }

  const identity = await getIdentity(ids[0]!);
  if (identity.status !== 'active') throw new HttpError(403, 'identity_locked', 'Identity is locked');
  await audit('login.ok', { identityId: identity.id, data: { similarity: matches[0]!.similarity, confidence } });
  res.json({
    status: 'logged_in',
    identity,
    sessionToken: issueToken('session', { sub: identity.id }, SESSION_TTL),
  });
});

authRouter.get('/me', async (req, res) => {
  res.json({ identity: await getIdentity(currentIdentityId(req)) });
});
