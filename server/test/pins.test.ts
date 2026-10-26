// Step 5 integration test: PINs, group throttle, recovery and login decisions.
// Real Postgres, no AWS. Run: npm run test:pins   (needs `npm run db:up`)
import pg from 'pg';

const devUrl = process.env.DATABASE_URL ?? 'postgres://twin:twin@localhost:5434/twin';
{
  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query('drop database if exists twin_test_pins with (force)');
  await admin.query('create database twin_test_pins');
  await admin.end();
}
process.env.DATABASE_URL = devUrl.replace(/\/[^/]+$/, '/twin_test_pins');
process.env.AWS_REGION ??= 'us-east-1';
process.env.COLLECTION_ID ??= 'unused';
process.env.TOKEN_SECRET = 'pins-test';

const { migrate, pool } = await import('../src/db.js');
const { hashSecret, verifySecret } = await import('../src/lib/secrets.js');
const pins = await import('../src/services/pins.js');
const { decideLogin } = await import('../src/services/login.js');
await migrate();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
};
async function errCode(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}

async function identity(name: string, code: string) {
  const id = (await pool.query(`insert into identities (display_name) values ($1) returning id`, [name])).rows[0].id as string;
  await pool.query(`insert into credentials (identity_id, recovery_code_hash) values ($1, $2)`, [id, await hashSecret(code)]);
  return id;
}
async function group(...ids: string[]) {
  const g = (await pool.query(`insert into collision_groups default values returning id`)).rows[0].id as string;
  for (const id of ids) await pool.query(`insert into group_members (identity_id, group_id) values ($1, $2)`, [id, g]);
  return g;
}

try {
  // ---- format and weak PINs
  const A = await identity('Alice', 'AAAA-AAAA-AAAA');
  const B = await identity('Bella', 'BBBB-BBBB-BBBB');
  const G = await group(A, B);
  for (const [pin, code] of [['12345', 'pin_format'], ['12a456', 'pin_format'], ['111111', 'pin_weak'], ['123456', 'pin_weak'], ['654321', 'pin_weak'], ['890123', 'pin_weak']] as const) {
    check(`PIN ${pin} rejected (${code})`, (await errCode(pins.setPin(A, pin))) === code);
  }

  // ---- uniqueness inside the group
  check('A sets PIN 482916', (await errCode(pins.setPin(A, '482916'))) === undefined);
  check('B cannot take the same PIN -> pin_taken', (await errCode(pins.setPin(B, '482916'))) === 'pin_taken');
  check('B sets PIN 739205', (await errCode(pins.setPin(B, '739205'))) === undefined);
  check('changing a PIN needs the current one', (await errCode(pins.setPin(A, '561937'))) === 'wrong_current_pin');
  check('...wrong current PIN refused', (await errCode(pins.setPin(A, '561937', { currentPin: '000001' }))) === 'wrong_current_pin');
  check('...right current PIN works', (await errCode(pins.setPin(A, '561937', { currentPin: '482916' }))) === undefined);
  check('A cannot change to B\'s PIN', (await errCode(pins.setPin(A, '739205', { currentPin: '561937' }))) === 'pin_taken');

  // ---- login by PIN
  check('A\'s PIN logs in A', (await pins.loginWithPin([G], '561937')) === A);
  check('B\'s PIN logs in B', (await pins.loginWithPin([G], '739205')) === B);
  let e: any;
  try { await pins.loginWithPin([G], '902817'); } catch (x) { e = x; }
  check('wrong PIN -> wrong_pin, 4 attempts left', e?.code === 'wrong_pin' && e?.extra?.attemptsLeft === 4, e?.extra);

  // ---- group throttle (never a member lock)
  for (let i = 0; i < 4; i++) await errCode(pins.loginWithPin([G], '902817'));
  check('after 5 wrong PINs even the right PIN is throttled -> 429', (await errCode(pins.loginWithPin([G], '561937'))) === 'group_throttled');
  const locks = (await pool.query(`select count(*)::int n from credentials where identity_id = any($1) and locked_until is not null`, [[A, B]])).rows[0].n;
  check('...but no member credential is locked', locks === 0, locks);
  await pool.query(`update group_login_attempts set at = now() - interval '16 minutes'`);
  check('throttle lifts after the window', (await pins.loginWithPin([G], '561937')) === A);

  // ---- recovery: forgot PIN / no PIN yet
  try { await pins.loginWithRecovery([G], 'WRON-GCOD-EXXX', '381904'); e = null; } catch (x) { e = x; }
  check('wrong recovery code -> wrong_code (counts toward throttle)', e?.code === 'wrong_code' && e?.extra?.attemptsLeft === 4, e?.extra);
  check('recovery with a PIN that clashes changes nothing', (await errCode(pins.loginWithRecovery([G], 'bbbb-bbbb-bbbb', '561937'))) === 'pin_taken');
  check('...B\'s old PIN still works', (await pins.loginWithPin([G], '739205')) === B);
  const r = await pins.loginWithRecovery([G], 'bbbb-bbbb-bbbb', '381904');
  check('B recovers with code + new PIN', r.identityId === B);
  check('...new PIN works', (await pins.loginWithPin([G], '381904')) === B);
  check('...old PIN no longer works', (await errCode(pins.loginWithPin([G], '739205'))) === 'wrong_pin');
  const hash = (await pool.query(`select recovery_code_hash from credentials where identity_id = $1`, [B])).rows[0].recovery_code_hash;
  check('...recovery code rotated (old one spent)', !(await verifySecret('BBBB-BBBB-BBBB', hash)) && (await verifySecret(r.recoveryCode, hash)));

  // ---- member with no PIN yet can only get in via recovery
  const C = await identity('Cara', 'CCCC-CCCC-CCCC');
  const D = await identity('Dina', 'DDDD-DDDD-DDDD');
  const G2 = await group(C, D);
  check('group with no PINs: any PIN fails', (await errCode(pins.loginWithPin([G2], '561937'))) === 'wrong_pin');
  check('C sets first PIN via recovery', (await pins.loginWithRecovery([G2], 'CCCC-CCCC-CCCC', '274618')).identityId === C);

  // ---- race: two members set the same PIN at the same moment
  const out = await Promise.allSettled([pins.setPin(D, '958271'), pins.setPin(C, '958271', { currentPin: '274618' })]);
  check('parallel identical PINs in one group: exactly one wins', out.filter((o) => o.status === 'fulfilled').length === 1, out.map((o) => o.status));

  // ---- login decisions (what a face match allows)
  const E = await identity('Eve', 'EEEE-EEEE-EEEE');
  const F = await identity('Fay', 'FFFF-FFFF-FFFF');
  let d = await decideLogin([{ identityId: E, similarity: 99 }]);
  check('single ungrouped identity -> logged in by face', d.kind === 'identity' && d.identityId === E, d);
  d = await decideLogin([{ identityId: A, similarity: 99 }]);
  check('face matches one group member -> pin_required for the group', d.kind === 'pin_required' && d.groupIds[0] === G, d);
  d = await decideLogin([{ identityId: A, similarity: 99 }, { identityId: B, similarity: 98 }]);
  check('face matches both twins -> pin_required (one group)', d.kind === 'pin_required' && d.groupIds.length === 1, d);
  check('two ungrouped identities -> ambiguous_match', (await errCode(decideLogin([{ identityId: E, similarity: 99 }, { identityId: F, similarity: 98 }]))) === 'ambiguous_match');
  check('group member + stray ungrouped identity -> ambiguous_match', (await errCode(decideLogin([{ identityId: A, similarity: 99 }, { identityId: E, similarity: 98 }]))) === 'ambiguous_match');
  check('no match -> no_match', (await errCode(decideLogin([]))) === 'no_match');
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
