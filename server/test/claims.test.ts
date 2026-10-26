// Step 3 integration test: claim state machine against a real Postgres.
// No AWS calls. Uses its own database (twin_test), so dev data is untouched.
// Run: npm run test:claims   (needs `npm run db:up`)
import { spawn } from 'node:child_process';
import pg from 'pg';

const devUrl = process.env.DATABASE_URL ?? 'postgres://twin:twin@localhost:5434/twin';
const testUrl = devUrl.replace(/\/[^/]+$/, '/twin_test');
{
  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query('drop database if exists twin_test with (force)');
  await admin.query('create database twin_test');
  await admin.end();
}
process.env.DATABASE_URL = testUrl;
process.env.TOKEN_SECRET = 'claims-test-secret';
process.env.AWS_REGION ??= 'us-east-1'; // no AWS calls are made, but config needs values
process.env.COLLECTION_ID ??= 'unused-in-claims-test';
// Imported after env is set: config reads it at import time.
const { hashSecret } = await import('../src/lib/secrets.js');
const { issueToken } = await import('../src/lib/tokens.js');

const base = 'http://localhost:4100';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
};
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
}

const server = spawn('npx', ['tsx', 'src/index.ts'], { env: { ...process.env, PORT: '4100' }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
await new Promise<void>((res) => server.stdout!.on('data', (d) => String(d).includes('server on') && res()));

async function makeIdentity(name: string, code: string) {
  const id = (await db.query(`insert into identities (display_name) values ($1) returning id`, [name])).rows[0].id;
  await db.query(`insert into credentials (identity_id, recovery_code_hash) values ($1, $2)`, [id, await hashSecret(code)]);
  return id as string;
}
const session = (id: string) => ({ authorization: `Bearer ${issueToken('session', { sub: id }, 3600)}` });
const match = (ids: string[]) => issueToken('match', { identityIds: ids }, 600);

try {
  const A = await makeIdentity('Alice', 'AAAA-BBBB-CCCC');
  const X = await makeIdentity('Mallory', 'XXXX-YYYY-ZZZZ');

  // open
  let r = await call('POST', '/claims', { matchToken: match([A]), claimantName: 'Bella' });
  check('open claim -> 201 open', r.status === 201 && r.body.claim.state === 'open', r);
  const claimId = r.body.claim.id; const ct = { 'x-claim-token': r.body.claimToken };

  r = await call('POST', '/claims', { matchToken: match([A]), claimantName: 'Again' });
  check('second open claim on same identity -> 409 with expiresAt', r.status === 409 && r.body.error === 'claim_already_open' && !!r.body.expiresAt, r);

  r = await call('POST', '/claims', { matchToken: match([A, X]), claimantName: 'C' });
  check('claim against group/multi -> 409 unsupported', r.status === 409 && r.body.error === 'group_claim_unsupported', r);

  r = await call('POST', '/claims', { matchToken: issueToken('session', { sub: A }, 60), claimantName: 'C' });
  check('session token used as match token -> 401', r.status === 401, r);

  r = await call('GET', `/claims/${claimId}`, undefined, ct);
  check('claimant reads status', r.status === 200 && r.body.role === 'claimant' && !!r.body.claim.nextStep, r);

  r = await call('GET', `/me/claims`, undefined, session(A));
  check('owner sees pending claim', r.status === 200 && r.body.claims.length === 1, r);

  r = await call('POST', `/claims/${claimId}/owner-confirm`, { recoveryCode: 'XXXX-YYYY-ZZZZ' }, session(X));
  check('other identity cannot confirm -> 403 not_owner', r.status === 403 && r.body.error === 'not_owner', r);

  r = await call('POST', `/claims/${claimId}/owner-confirm`, { recoveryCode: 'WRON-GCOD-EEEE' }, session(A));
  check('wrong code -> 403 with attemptsLeft 4', r.status === 403 && r.body.attemptsLeft === 4, r);
  const fails = (await db.query('select failed_attempts from credentials where identity_id=$1', [A])).rows[0].failed_attempts;
  check('failed attempt counter committed', fails === 1, fails);

  r = await call('POST', `/claims/${claimId}/owner-confirm`, { recoveryCode: 'aaaa-bbbb-cccc' }, session(A));
  check('right code (any case) -> owner_confirmed', r.status === 200 && r.body.claim.state === 'owner_confirmed', r);

  r = await call('POST', `/claims/${claimId}/owner-confirm`, { recoveryCode: 'AAAA-BBBB-CCCC' }, session(A));
  check('confirm twice -> 409', r.status === 409, r);

  r = await call('DELETE', `/claims/${claimId}`, undefined, ct);
  check('claimant cancels -> cancelled', r.status === 200 && r.body.claim.state === 'cancelled', r);

  // claimant lost their token after owner confirmed: owner can still cancel it
  r = await call('POST', '/claims', { matchToken: match([A]), claimantName: 'Lost' });
  const lost = r.body.claim.id;
  await call('POST', `/claims/${lost}/owner-confirm`, { recoveryCode: 'AAAA-BBBB-CCCC' }, session(A));
  r = await call('POST', `/claims/${lost}/owner-cancel`, {}, session(X));
  check('other identity cannot owner-cancel -> 403', r.status === 403, r);
  r = await call('POST', `/claims/${lost}/owner-cancel`, {}, session(A));
  check('owner cancels confirmed claim -> cancelled', r.status === 200 && r.body.claim.state === 'cancelled', r);

  // decline path
  r = await call('POST', '/claims', { matchToken: match([A]), claimantName: 'Bella' });
  check('new claim allowed after cancel', r.status === 201, r);
  const c2 = r.body.claim.id;
  r = await call('POST', `/claims/${c2}/owner-decline`, {}, session(A));
  check('owner declines -> review', r.status === 200 && r.body.claim.state === 'review' && r.body.claim.reviewReason === 'owner_declined', r);

  // lockout: 5 wrong codes
  r = await call('POST', '/claims', { matchToken: match([A]), claimantName: 'Bella' });
  const c3 = r.body.claim.id;
  let last: any;
  for (let i = 0; i < 5; i++) last = await call('POST', `/claims/${c3}/owner-confirm`, { recoveryCode: 'NOPE-NOPE-NOPE' }, session(A));
  r = await call('POST', `/claims/${c3}/owner-confirm`, { recoveryCode: 'AAAA-BBBB-CCCC' }, session(A));
  check('after 5 wrong codes even the right one is locked -> 423', r.status === 423, { last, r });

  // expiry: lazy and sweeper
  await db.query(`update claims set expires_at = now() - interval '1 second' where id = $1`, [c3]);
  r = await call('GET', `/claims/${c3}`, undefined, session(A));
  check('overdue claim reads as expired (lazy)', r.body.claim?.state === 'expired', r);
  const c4 = (await call('POST', '/claims', { matchToken: match([X]), claimantName: 'Q' })).body.claim.id;
  await db.query(`update claims set expires_at = now() - interval '1 second' where id = $1`, [c4]);
  r = await call('GET', `/me/claims`, undefined, session(X));
  const st = (await db.query('select state from claims where id=$1', [c4])).rows[0].state;
  check('sweeper expires overdue claims', r.body.claims.length === 0 && st === 'expired', { r, st });

  // race: two parallel cancels, only one wins
  const c5r = await call('POST', '/claims', { matchToken: match([X]), claimantName: 'R' });
  const h5 = { 'x-claim-token': c5r.body.claimToken };
  const both = await Promise.all([call('DELETE', `/claims/${c5r.body.claim.id}`, undefined, h5), call('DELETE', `/claims/${c5r.body.claim.id}`, undefined, h5)]);
  const codes = both.map((b) => b.status).sort();
  check('parallel cancels: one 200, one 409', codes[0] === 200 && codes[1] === 409, codes);

  r = await call('GET', `/claims/${c5r.body.claim.id}`, undefined, { 'x-claim-token': issueToken('claim', { claimId: c2 }, 60) });
  check('claim token for another claim -> 403', r.status === 403, r);

  const audits = (await db.query(`select type, count(*)::int n from audit_events group by type order by type`)).rows;
  console.log('audit:', audits.map((a) => `${a.type}=${a.n}`).join(' '));
} finally {
  process.kill(-server.pid!, 'SIGTERM');
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
