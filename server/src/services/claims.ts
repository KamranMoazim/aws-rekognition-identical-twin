import { createHash, randomInt } from 'node:crypto';
import type pg from 'pg';
import { pool, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { groupsOf } from './identities.js';

/**
 * Claim state machine (see build plan):
 *
 *   open -> owner_confirmed -> both_live -> challenged -> resolved
 *                                              |  (3rd failure)
 *                                              v
 *   any active state --(owner declines)-->  review
 *   any active state --(timeout)-------->   expired
 *   any active state --(claimant quits)-->  cancelled
 *
 * Every change goes through transition(): row lock + allowed from-states.
 */
export const ACTIVE_STATES = ['open', 'owner_confirmed', 'both_live', 'challenged'] as const;
export const TERMINAL_STATES = ['resolved', 'review', 'expired', 'cancelled'] as const;
export type ClaimState = (typeof ACTIVE_STATES)[number] | (typeof TERMINAL_STATES)[number];

const CLAIM_TTL_HOURS = 24;
/** Twins and triplets: with 3 people every person still gets a different head movement. */
export const MAX_GROUP_SIZE = 3;
/** Failed claims (cancelled / expired / review) against one target within the window before new ones go to review. */
export const REPEAT_LIMIT = 3;
export const REPEAT_WINDOW_DAYS = 30;

export type Claim = {
  id: string;
  targetIdentityId: string;
  targetGroupId: string | null;
  claimantName: string;
  state: ClaimState;
  expiresAt: string;
  attemptCount: number;
  ownerConfirmedAt: string | null;
  reviewReason: string | null;
  resultIdentityId: string | null;
  createdAt: string;
  closedAt: string | null;
  reviewDecision: string | null;
};

const isActive = (s: ClaimState) => (ACTIVE_STATES as readonly string[]).includes(s);
const isTerminal = (s: ClaimState) => (TERMINAL_STATES as readonly string[]).includes(s);

function toClaim(r: Record<string, any>): Claim {
  return {
    id: r.id,
    targetIdentityId: r.target_identity_id,
    targetGroupId: r.target_group_id,
    claimantName: r.claimant_name,
    state: r.state,
    expiresAt: r.expires_at,
    attemptCount: r.attempt_count,
    ownerConfirmedAt: r.owner_confirmed_at,
    reviewReason: r.review_reason,
    resultIdentityId: r.result_identity_id,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    reviewDecision: r.review_decision,
  };
}

/** Plain-language next step, shown to both people. */
export function nextStep(state: ClaimState): string {
  switch (state) {
    case 'open':
      return 'Waiting for the account owner(s) to log in and confirm with their recovery code.';
    case 'owner_confirmed':
      return 'Owners confirmed. Next: on one device, each owner and then you pass a liveness check, one at a time.';
    case 'both_live':
      return 'Everyone passed liveness. Next: stand together in front of the camera for the joint check.';
    case 'challenged':
      return 'Joint check running: follow the instructions on screen.';
    case 'resolved':
      return 'Resolved: a separate identity was created.';
    case 'review':
      return 'Sent to manual review. The existing account is unaffected.';
    case 'expired':
      return 'Expired. Nothing changed; you can start a new claim.';
    case 'cancelled':
      return 'Cancelled. Nothing changed.';
  }
}

// Same alphabet as recovery codes: easy to read back.
const RESUME_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newResumeCode = () =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => RESUME_ALPHABET[randomInt(RESUME_ALPHABET.length)]).join('')).join('-');
/** Resume codes are random (~59 bits), so a fast hash is fine and lets us look them up directly. */
export const hashResumeCode = (code: string) =>
  createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

/** The identities whose account a claim is about: one identity, or every member of its group. */
export async function claimMembers(claim: Pick<Claim, 'targetIdentityId' | 'targetGroupId'>, db: Pick<pg.PoolClient, 'query'> = pool): Promise<string[]> {
  if (!claim.targetGroupId) return [claim.targetIdentityId];
  const r = await db.query<{ identity_id: string }>(
    'select identity_id from group_members where group_id = $1 order by joined_at',
    [claim.targetGroupId],
  );
  return r.rows.map((x) => x.identity_id);
}

export type OpenedClaim = { claim: Claim; resumeCode: string };

/**
 * Open a "this is not my account" claim against whatever the face matched:
 * one identity, or a whole collision group (a third lookalike must then prove
 * themselves against EVERY member).
 */
export async function openClaim(matchedIdentityIds: string[], claimantName: string): Promise<OpenedClaim> {
  const groupIds = await groupsOf(matchedIdentityIds);
  let targetIdentityId: string;
  let targetGroupId: string | null = null;

  if (groupIds.length > 1) {
    throw new HttpError(409, 'ambiguous_match', 'This face matches more than one collision group. Claim refused.');
  }
  if (groupIds.length === 1) {
    targetGroupId = groupIds[0]!;
    const members = await claimMembers({ targetIdentityId: '', targetGroupId });
    if (matchedIdentityIds.some((id) => !members.includes(id))) {
      throw new HttpError(409, 'ambiguous_match', 'This face matches identities outside one group. Claim refused.');
    }
    if (members.length >= MAX_GROUP_SIZE) {
      throw new HttpError(409, 'group_full', `Collision groups are limited to ${MAX_GROUP_SIZE} people. This needs manual handling.`);
    }
    targetIdentityId = members[0]!;
  } else {
    if (matchedIdentityIds.length !== 1) {
      throw new HttpError(409, 'ambiguous_match', 'This face matches more than one identity. Claim refused.');
    }
    targetIdentityId = matchedIdentityIds[0]!;
  }

  // Repeat limit: too many failed claims against this target recently -> straight to review.
  const recent = await pool.query<{ n: number }>(
    `select count(*)::int as n from claims
      where (target_identity_id = $1 or (target_group_id is not null and target_group_id = $2))
        and state in ('cancelled', 'expired', 'review')
        and created_at > now() - make_interval(days => $3)`,
    [targetIdentityId, targetGroupId, REPEAT_WINDOW_DAYS],
  );
  const tooMany = recent.rows[0]!.n >= REPEAT_LIMIT;

  const resumeCode = newResumeCode();
  try {
    const r = await pool.query(
      `insert into claims (target_identity_id, target_group_id, claimant_name, state, expires_at,
                           resume_code_hash, review_reason, closed_at)
       values ($1, $2, $3, $4, now() + make_interval(hours => $5), $6, $7, $8) returning *`,
      [
        targetIdentityId,
        targetGroupId,
        claimantName,
        tooMany ? 'review' : 'open',
        CLAIM_TTL_HOURS,
        hashResumeCode(resumeCode),
        tooMany ? 'too_many_claims' : null,
        tooMany ? new Date() : null,
      ],
    );
    const claim = toClaim(r.rows[0]);
    await audit(tooMany ? 'claim.opened_into_review' : 'claim.opened', {
      claimId: claim.id,
      identityId: targetIdentityId,
      data: { claimantName, targetGroupId, recentFailedClaims: recent.rows[0]!.n },
    });
    return { claim, resumeCode };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const open = await pool.query<{ expires_at: string }>(
        `select expires_at from claims
          where (target_identity_id = $1 or (target_group_id is not null and target_group_id = $2)) and state = any($3)`,
        [targetIdentityId, targetGroupId, [...ACTIVE_STATES]],
      );
      throw new HttpError(
        409,
        'claim_already_open',
        'A claim against this identity is already in progress. Resume it with its resume code, ' +
          'or ask the account owner to cancel it. Otherwise it expires on its own.',
        { expiresAt: open.rows[0]?.expires_at },
      );
    }
    throw err;
  }
}

/** Find an active claim by its resume code (claimant on another device). */
export async function claimByResumeCode(code: string): Promise<Claim> {
  await expireDueClaims();
  const r = await pool.query('select * from claims where resume_code_hash = $1', [hashResumeCode(code)]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'claim_not_found', 'No claim with this resume code.');
  const claim = toClaim(row);
  if (!isActive(claim.state)) throw new HttpError(409, 'claim_closed', `This claim is ${claim.state}.`, { state: claim.state });
  return claim;
}

export async function getClaim(id: string): Promise<Claim> {
  const r = await pool.query('select * from claims where id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'claim_not_found', 'Claim not found');
  const claim = toClaim(r.rows[0]);
  // Lazy expiry: never show a stale active state, even between sweeps.
  if (isActive(claim.state) && new Date(claim.expiresAt) < new Date()) {
    return (await transition(id, [...ACTIVE_STATES], 'expired', { auditType: 'claim.expired' })).claim;
  }
  return claim;
}

type TransitionOpts = {
  reviewReason?: string;
  auditType: string;
  auditData?: unknown;
  /** Extra writes inside the same transaction (e.g. create identity on resolve). */
  also?: (c: pg.PoolClient, claim: Claim) => Promise<void>;
};

/**
 * The ONLY way a claim changes state. Locks the row, checks the move is
 * allowed from the current state, and expires the claim instead if its time
 * is up. `moved` is true only if THIS call wrote `to`, so two racing callers
 * can never both succeed.
 */
async function transition(
  id: string,
  from: ClaimState[],
  to: ClaimState,
  opts: TransitionOpts,
): Promise<{ claim: Claim; moved: boolean }> {
  return tx(async (c) => {
    const row = (await c.query('select *, expires_at < now() as overdue from claims where id = $1 for update', [id]))
      .rows[0];
    if (!row) throw new HttpError(404, 'claim_not_found', 'Claim not found');
    const current = toClaim(row);

    let target = to;
    let auditType = opts.auditType;
    if (isActive(current.state) && row.overdue && to !== 'expired') {
      target = 'expired'; // time is up: expire instead of moving forward
      auditType = 'claim.expired';
    } else if (!from.includes(current.state)) {
      return { claim: current, moved: false }; // not allowed from here
    }

    let updated = toClaim(
      (
        await c.query(
          `update claims set
             state = $2,
             updated_at = now(),
             owner_confirmed_at = case when $2 = 'owner_confirmed' then now() else owner_confirmed_at end,
             review_reason = coalesce($3, review_reason),
             closed_at = case when $4 then now() else null end
           where id = $1 returning *`,
          [id, target, target === 'review' ? (opts.reviewReason ?? null) : null, isTerminal(target)],
        )
      ).rows[0],
    );
    if (target === to && opts.also) {
      await opts.also(c, updated);
      updated = toClaim((await c.query('select * from claims where id = $1', [id])).rows[0]); // see the extra writes
    }
    await audit(auditType, { claimId: id, identityId: current.targetIdentityId, data: opts.auditData }, c);
    return { claim: updated, moved: target === to };
  });
}

export { transition };

/** transition() that throws when the claim did not land in the wanted state. */
export async function move(id: string, from: ClaimState[], to: ClaimState, opts: TransitionOpts): Promise<Claim> {
  const { claim, moved } = await transition(id, from, to, opts);
  if (moved) return claim;
  if (claim.state === 'expired') throw new HttpError(410, 'claim_expired', 'This claim has expired.');
  throw new HttpError(409, 'bad_claim_state', `Claim is ${claim.state}; cannot move to ${to}.`, { state: claim.state });
}

/** Sweeper: expire every overdue active claim. Safe to run often. */
export async function expireDueClaims(): Promise<number> {
  const r = await pool.query<{ id: string; target_identity_id: string }>(
    `update claims set state = 'expired', closed_at = now(), updated_at = now()
      where state = any($1) and expires_at < now()
      returning id, target_identity_id`,
    [[...ACTIVE_STATES]],
  );
  for (const row of r.rows) {
    await audit('claim.expired', { claimId: row.id, identityId: row.target_identity_id, data: { by: 'sweeper' } });
  }
  return r.rowCount ?? 0;
}

export async function activeClaimsAgainst(identityId: string): Promise<Claim[]> {
  await expireDueClaims();
  const r = await pool.query(
    `select * from claims
      where state = any($2)
        and (target_identity_id = $1
             or target_group_id in (select group_id from group_members where identity_id = $1))
      order by created_at desc`,
    [identityId, [...ACTIVE_STATES]],
  );
  return r.rows.map(toClaim);
}

export async function isClaimOwner(claim: Claim, identityId: string): Promise<boolean> {
  return (await claimMembers(claim)).includes(identityId);
}

/** Which members have confirmed. The claim moves on only when all of them have. */
export async function confirmations(claim: Claim): Promise<{ confirmed: string[]; required: string[] }> {
  const required = await claimMembers(claim);
  const r = await pool.query<{ identity_id: string }>('select identity_id from claim_confirmations where claim_id = $1', [claim.id]);
  return { confirmed: r.rows.map((x) => x.identity_id).filter((id) => required.includes(id)), required };
}

/**
 * One member confirms (recovery code already checked by the caller).
 * The last confirmation moves the claim to owner_confirmed, atomically.
 */
export async function confirmAsMember(claimId: string, identityId: string): Promise<Claim> {
  const { claim } = await transition(claimId, ['open'], 'open', {
    auditType: 'claim.member_confirmed',
    auditData: { identityId },
    also: async (c) => {
      await c.query('insert into claim_confirmations (claim_id, identity_id) values ($1, $2) on conflict do nothing', [claimId, identityId]);
    },
  });
  if (claim.state !== 'open') {
    if (claim.state === 'expired') throw new HttpError(410, 'claim_expired', 'This claim has expired.');
    throw new HttpError(409, 'bad_claim_state', `Claim is ${claim.state}`);
  }
  const { confirmed, required } = await confirmations(claim);
  if (confirmed.length < required.length) return claim;
  const moved = await transition(claimId, ['open'], 'owner_confirmed', { auditType: 'claim.owner_confirmed' });
  return moved.claim; // a parallel last confirmation may have moved it already: either way it is confirmed
}
