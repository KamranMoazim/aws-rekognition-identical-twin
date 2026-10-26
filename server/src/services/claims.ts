import type pg from 'pg';
import { pool, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';

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

export type Claim = {
  id: string;
  targetIdentityId: string;
  claimantName: string;
  state: ClaimState;
  expiresAt: string;
  attemptCount: number;
  ownerConfirmedAt: string | null;
  reviewReason: string | null;
  resultIdentityId: string | null;
  createdAt: string;
  closedAt: string | null;
};

const isActive = (s: ClaimState) => (ACTIVE_STATES as readonly string[]).includes(s);
const isTerminal = (s: ClaimState) => (TERMINAL_STATES as readonly string[]).includes(s);

function toClaim(r: Record<string, any>): Claim {
  return {
    id: r.id,
    targetIdentityId: r.target_identity_id,
    claimantName: r.claimant_name,
    state: r.state,
    expiresAt: r.expires_at,
    attemptCount: r.attempt_count,
    ownerConfirmedAt: r.owner_confirmed_at,
    reviewReason: r.review_reason,
    resultIdentityId: r.result_identity_id,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

/** Plain-language next step, shown to both people. */
export function nextStep(state: ClaimState): string {
  switch (state) {
    case 'open':
      return 'Waiting for the account owner to log in and confirm with their recovery code.';
    case 'owner_confirmed':
      return 'Owner confirmed. Next: both people pass a liveness check, then a joint camera check (step 4).';
    case 'both_live':
    case 'challenged':
      return 'Joint camera check in progress (step 4).';
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

/** Open a "this is not my account" claim against the identity a face matched. */
export async function openClaim(matchedIdentityIds: string[], claimantName: string): Promise<Claim> {
  if (matchedIdentityIds.length !== 1) {
    // A face matching several identities means a collision group already exists.
    // A third lookalike must prove themselves against every member: step 6.
    throw new HttpError(409, 'group_claim_unsupported', 'This face matches a collision group. Claims against groups come in step 6.');
  }
  const target = matchedIdentityIds[0]!;
  try {
    const r = await pool.query(
      `insert into claims (target_identity_id, claimant_name, state, expires_at)
       values ($1, $2, 'open', now() + make_interval(hours => $3)) returning *`,
      [target, claimantName, CLAIM_TTL_HOURS],
    );
    const claim = toClaim(r.rows[0]);
    await audit('claim.opened', { claimId: claim.id, identityId: target, data: { claimantName } });
    return claim;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const open = await pool.query<{ expires_at: string }>(
        'select expires_at from claims where target_identity_id = $1 and state = any($2)',
        [target, [...ACTIVE_STATES]],
      );
      throw new HttpError(
        409,
        'claim_already_open',
        'A claim against this identity is already in progress. Resume it in the browser where you opened it, ' +
          'or ask the account owner to cancel it. Otherwise it expires on its own.',
        { expiresAt: open.rows[0]?.expires_at },
      );
    }
    throw err;
  }
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

    const updated = toClaim(
      (
        await c.query(
          `update claims set
             state = $2,
             updated_at = now(),
             owner_confirmed_at = case when $2 = 'owner_confirmed' then now() else owner_confirmed_at end,
             review_reason = coalesce($3, review_reason),
             closed_at = case when $4 then now() else closed_at end
           where id = $1 returning *`,
          [id, target, target === 'review' ? (opts.reviewReason ?? null) : null, isTerminal(target)],
        )
      ).rows[0],
    );
    if (target === to && opts.also) await opts.also(c, updated);
    await audit(auditType, { claimId: id, identityId: current.targetIdentityId, data: opts.auditData }, c);
    return { claim: updated, moved: target === to };
  });
}

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
    `select * from claims where target_identity_id = $1 and state = any($2) order by created_at desc`,
    [identityId, [...ACTIVE_STATES]],
  );
  return r.rows.map(toClaim);
}
