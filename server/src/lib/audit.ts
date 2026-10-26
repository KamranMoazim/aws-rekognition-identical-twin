import type pg from 'pg';
import { pool } from '../db.js';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function audit(
  type: string,
  refs: { identityId?: string; claimId?: string; data?: unknown } = {},
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    'insert into audit_events (type, identity_id, claim_id, data) values ($1, $2, $3, $4)',
    [type, refs.identityId ?? null, refs.claimId ?? null, refs.data === undefined ? null : JSON.stringify(refs.data)],
  );
}
