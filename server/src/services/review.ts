import { pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { claimMembers, confirmations, getClaim, move, type Claim } from './claims.js';

/**
 * Manual review: the one place a human decides. A reviewer never creates an
 * identity directly; they either close the claim (reject) or give it one more
 * automatic attempt (reopen), which still needs co-presence to resolve.
 */
export type ReviewItem = {
  claim: Claim;
  members: { id: string; displayName: string }[];
  confirmations: number;
  events: { type: string; at: string; data: unknown }[];
};

export async function reviewQueue(): Promise<ReviewItem[]> {
  const r = await pool.query(`select id from claims where state = 'review' and review_decision is null order by updated_at`);
  const items: ReviewItem[] = [];
  for (const { id } of r.rows) {
    const claim = (await pool.query('select * from claims where id = $1', [id])).rows[0];
    const c: Claim = {
      id: claim.id,
      targetIdentityId: claim.target_identity_id,
      targetGroupId: claim.target_group_id,
      claimantName: claim.claimant_name,
      state: claim.state,
      expiresAt: claim.expires_at,
      attemptCount: claim.attempt_count,
      ownerConfirmedAt: claim.owner_confirmed_at,
      reviewReason: claim.review_reason,
      resultIdentityId: claim.result_identity_id,
      createdAt: claim.created_at,
      closedAt: claim.closed_at,
      reviewDecision: claim.review_decision,
    };
    const memberIds = await claimMembers(c);
    const members = (
      await pool.query<{ id: string; display_name: string }>('select id, display_name from identities where id = any($1)', [memberIds])
    ).rows.map((m) => ({ id: m.id, displayName: m.display_name }));
    const events = (
      await pool.query<{ type: string; at: string; data: unknown }>(
        'select type, at, data from audit_events where claim_id = $1 order by id',
        [id],
      )
    ).rows;
    items.push({ claim: c, members, confirmations: (await confirmations(c)).confirmed.length, events });
  }
  return items;
}

export async function decide(claimId: string, decision: 'reject' | 'reopen'): Promise<Claim> {
  const row = (await pool.query('select state, review_decision, owner_confirmed_at from claims where id = $1', [claimId])).rows[0];
  if (!row) throw new HttpError(404, 'claim_not_found', 'Claim not found');
  if (row.state !== 'review' || row.review_decision) throw new HttpError(409, 'not_in_review', 'Claim is not waiting for review');

  if (decision === 'reject') {
    await pool.query(`update claims set review_decision = 'rejected', reviewed_at = now() where id = $1`, [claimId]);
    await audit('review.rejected', { claimId });
    return getClaim(claimId);
  }

  // Reopen: back to where the automatic flow can continue. Fresh 24 h and attempts.
  const to = row.owner_confirmed_at ? 'owner_confirmed' : 'open';
  try {
    return await move(claimId, ['review'], to, {
      auditType: 'review.reopened',
      auditData: { to },
      also: async (c) => {
        await c.query(
          `update claims set review_decision = 'reopened', reviewed_at = now(), attempt_count = 0,
                  expires_at = now() + interval '24 hours', challenge = null where id = $1`,
          [claimId],
        );
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'claim_already_open', 'Another claim against this target is in progress; cannot reopen.');
    }
    throw err;
  }
}
