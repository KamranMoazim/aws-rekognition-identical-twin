// Step 6 integration test (HTTP, real Postgres, no AWS): group confirmations,
// resume codes, repeat-claim limit, admin review queue.
// Run: npm run test:hardening   (needs `npm run db:up`)
import { spawn } from 'node:child_process';
import pg from 'pg';

const devUrl = process.env.DATABASE_URL ?? 'postgres://twin:twin@localhost:5434/twin';
{
  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query('drop database if exists twin_test_hardening with (force)');
  await admin.query('create database twin_test_hardening');
  await admin.end();
}
process.env.DATABASE_URL = devUrl.replace(/\/[^/]+$/, '/twin_test_hardening');
process.env.TOKEN_SECRET = 'hardening-test';
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.AWS_REGION ??= 'us-east-1';
process.env.COLLECTION_ID ??= 'unused';
const { hashSecret } = await import('../src/lib/secrets.js');
const { issueToken } = await import('../src/lib/tokens.js');

const base = 'http://localhost:4101';
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

const server = spawn('npx', ['tsx', 'src/index.ts'], { env: { ...process.env, PORT: '4101' }, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
await new Promise<void>((res) => server.stdout!.on('data', (d) => String(d).includes('server on') && res()));

async function identity(name: string, code: string) {
  const id = (await db.query(`insert into identities (display_name) values ($1) returning id`, [name])).rows[0].id as string;
  await db.query(`insert into credentials (identity_id, recovery_code_hash) values ($1, $2)`, [id, await hashSecret(code)]);
  return id;
}
const session = (id: string) => ({ authorization: `Bearer ${issueToken('session', { sub: id }, 3600)}` });
const match = (ids: string[]) => issueToken('match', { identityIds: ids }, 600);
const admin = { 'x-admin-token': 'admin-secret' };

try {
  // ---- group claim needs EVERY member to confirm
  const A = await identity('Alice', 'AAAA-AAAA-AAAA');
  const B = await identity('Bella', 'BBBB-BBBB-BBBB');
  const X = await identity('Xena', 'XXXX-XXXX-XXXX');
  const g = (await db.query(`insert into collision_groups default values returning id`)).rows[0].id;
  await db.query(`insert into group_members (identity_id, group_id) values ($1, $3), ($2, $3)`, [A, B, g]);

  let r = await call('POST', '/claims', { matchToken: match([B]), claimantName: 'Cleo' });
  check('claim on one member of a group -> targets the group', r.status === 201 && r.body.claim.owners.required === 2, r.body);
  const cid = r.body.claim.id;
  const resumeCode = r.body.resumeCode as string;

  r = await call('GET', '/me/claims', undefined, session(A));
  check('the OTHER member (Alice) also sees the claim', r.body.claims.length === 1 && r.body.claims[0].owners.youConfirmed === false, r.body);
  r = await call('GET', `/claims/${cid}`, undefined, session(X));
  check('a non-member cannot read it -> 403', r.status === 403, r.body);

  r = await call('POST', `/claims/${cid}/owner-confirm`, { recoveryCode: 'AAAA-AAAA-AAAA' }, session(A));
  check('first member confirms -> still open (1 of 2)', r.body.claim.state === 'open' && r.body.claim.owners.confirmed === 1, r.body);
  r = await call('POST', `/claims/${cid}/owner-confirm`, { recoveryCode: 'AAAA-AAAA-AAAA' }, session(A));
  check('same member twice -> already_confirmed', r.status === 409 && r.body.error === 'already_confirmed', r.body);
  r = await call('POST', `/claims/${cid}/owner-confirm`, { recoveryCode: 'AAAA-AAAA-AAAA' }, session(B));
  check('Bella cannot confirm with Alice\'s code', r.status === 403 && r.body.error === 'wrong_code', r.body);
  r = await call('POST', `/claims/${cid}/owner-confirm`, { recoveryCode: 'BBBB-BBBB-BBBB' }, session(B));
  check('second member confirms -> owner_confirmed (2 of 2)', r.body.claim.state === 'owner_confirmed' && r.body.claim.owners.confirmed === 2, r.body);

  // ---- resume on another device
  r = await call('POST', '/claims/resume', { resumeCode: resumeCode.toLowerCase() });
  check('resume code (any case) gives a new claim token', r.status === 200 && r.body.claim.id === cid && !!r.body.claimToken, r.body);
  r = await call('GET', `/claims/${cid}`, undefined, { 'x-claim-token': r.body.claimToken });
  check('...and that token works', r.status === 200 && r.body.role === 'claimant', r.body);
  r = await call('POST', '/claims/resume', { resumeCode: 'AAAA-BBBB-CCCC' });
  check('wrong resume code -> 404', r.status === 404, r.body);
  await db.query(`update claims set state = 'cancelled', closed_at = now() where id = $1`, [cid]);
  r = await call('POST', '/claims/resume', { resumeCode });
  check('resume code of a closed claim -> 409 claim_closed', r.status === 409 && r.body.error === 'claim_closed', r.body);

  // ---- repeat-claim limit: 3 failed claims in 30 days -> next goes straight to review
  const T = await identity('Tess', 'TTTT-TTTT-TTTT');
  for (let i = 0; i < 2; i++) {
    const o = await call('POST', '/claims', { matchToken: match([T]), claimantName: `try${i}` });
    await call('DELETE', `/claims/${o.body.claim.id}`, undefined, { 'x-claim-token': o.body.claimToken });
  }
  r = await call('POST', '/claims', { matchToken: match([T]), claimantName: 'try2' });
  check('3rd claim still opens normally', r.body.claim.state === 'open', r.body);
  await call('DELETE', `/claims/${r.body.claim.id}`, undefined, { 'x-claim-token': r.body.claimToken });
  r = await call('POST', '/claims', { matchToken: match([T]), claimantName: 'try3' });
  check('4th claim after 3 failed ones -> straight to review (too_many_claims)', r.body.claim.state === 'review' && r.body.claim.reviewReason === 'too_many_claims', r.body);
  const repeatId = r.body.claim.id;

  // ---- admin review queue
  r = await call('GET', '/admin/review-queue');
  check('admin without token -> 401', r.status === 401, r.body);
  r = await call('GET', '/admin/review-queue', undefined, { 'x-admin-token': 'nope' });
  check('admin with wrong token -> 401', r.status === 401, r.body);

  // a claim the owner declined
  const D = await identity('Dora', 'DDDD-DDDD-DDDD');
  r = await call('POST', '/claims', { matchToken: match([D]), claimantName: 'Eve' });
  const declined = r.body.claim.id;
  await call('POST', `/claims/${declined}/owner-decline`, {}, session(D));

  r = await call('GET', '/admin/review-queue', undefined, admin);
  const ids = r.body.items.map((i: any) => i.claim.id);
  check('queue lists both review claims with audit trail', ids.includes(repeatId) && ids.includes(declined) && r.body.items.every((i: any) => i.events.length > 0), r.body.items?.map((i: any) => i.claim.reviewReason));

  r = await call('POST', `/admin/claims/${repeatId}/decision`, { decision: 'reject' }, admin);
  check('reject -> stays review, decision recorded', r.body.claim.state === 'review' && r.body.claim.reviewDecision === 'rejected', r.body);
  r = await call('POST', `/admin/claims/${repeatId}/decision`, { decision: 'reopen' }, admin);
  check('decided claim cannot be decided again', r.status === 409, r.body);

  r = await call('POST', `/admin/claims/${declined}/decision`, { decision: 'reopen' }, admin);
  check('reopen a declined claim -> back to open (owner never confirmed)', r.body.claim.state === 'open', r.body);
  r = await call('GET', '/admin/review-queue', undefined, admin);
  check('queue is empty after both decisions', r.body.items.length === 0, r.body.items);
  r = await call('POST', `/claims/${declined}/owner-confirm`, { recoveryCode: 'DDDD-DDDD-DDDD' }, session(D));
  check('reopened claim continues normally (owner confirms)', r.body.claim.state === 'owner_confirmed', r.body);
} finally {
  process.kill(-server.pid!, 'SIGTERM');
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
