import { Router, type Request } from 'express';
import { audit } from '../lib/audit.js';
import { HttpError, requireString } from '../lib/http.js';
import { issueToken, readToken } from '../lib/tokens.js';
import { searchByImage, type IdentityMatch } from '../services/faces.js';
import { createIdentity, getIdentity } from '../services/identities.js';
import { decideLogin } from '../services/login.js';
import { hasPin, loginWithPin, loginWithRecovery, setPin } from '../services/pins.js';
import { consumeLiveness, createLivenessSession, type LivenessPurpose } from '../services/liveness.js';

export const authRouter = Router();

const SESSION_TTL = 12 * 60 * 60; // 12 h
const MATCH_TTL = 10 * 60; // 10 min to decide "this is not me"
const PIN_TOKEN_TTL = 5 * 60; // 5 min to type the PIN after the face check

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
    error: 'face_match',
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
  const decision = await decideLogin(await searchByImage(bytes), confidence);

  if (decision.kind === 'pin_required') {
    // The face found a collision group; the PIN (or recovery code) picks the member.
    res.json({
      status: 'pin_required',
      message: 'This face belongs to more than one person. Enter your PIN.',
      pinToken: issueToken('pin', { groupIds: decision.groupIds }, PIN_TOKEN_TTL),
    });
    return;
  }
  res.json(await loggedIn(decision.identityId));
});

/** Face matched a group: PIN picks the member. */
authRouter.post('/login/pin', async (req, res) => {
  const { groupIds } = readToken<{ groupIds: string[] }>(requireString(req.body, 'pinToken', 4000), 'pin');
  const identityId = await loginWithPin(groupIds, requireString(req.body, 'pin', 20));
  res.json(await loggedIn(identityId));
});

/** No PIN yet or forgot it: recovery code picks the member, sets a new PIN, rotates the code. */
authRouter.post('/login/recovery', async (req, res) => {
  const { groupIds } = readToken<{ groupIds: string[] }>(requireString(req.body, 'pinToken', 4000), 'pin');
  const { identityId, recoveryCode } = await loginWithRecovery(
    groupIds,
    requireString(req.body, 'recoveryCode', 40),
    requireString(req.body, 'newPin', 20),
  );
  res.json({ ...(await loggedIn(identityId)), recoveryCode }); // new code, shown ONCE
});

async function loggedIn(identityId: string) {
  const identity = await getIdentity(identityId);
  if (identity.status !== 'active') throw new HttpError(403, 'identity_locked', 'Identity is locked');
  return {
    status: 'logged_in' as const,
    identity,
    sessionToken: issueToken('session', { sub: identity.id }, SESSION_TTL),
  };
}

authRouter.get('/me', async (req, res) => {
  const identity = await getIdentity(currentIdentityId(req));
  const pin = await hasPin(identity.id);
  // A group member without a PIN can only log in again via the recovery code: nudge them.
  res.json({ identity, hasPin: pin, needsPin: !!identity.groupId && !pin });
});

/** Set or change my PIN. Body: { pin, currentPin? } */
authRouter.post('/me/pin', async (req, res) => {
  const identityId = currentIdentityId(req);
  const body = req.body as { currentPin?: unknown };
  await setPin(identityId, requireString(req.body, 'pin', 20), {
    currentPin: typeof body.currentPin === 'string' ? body.currentPin : undefined,
  });
  res.json({ ok: true });
});
