// Step 4 integration test: the co-presence flow end to end against Postgres,
// with Rekognition replaced by a scripted fake (no AWS calls, no second person).
// Run: npm run test:copresence   (needs `npm run db:up`)
import pg from 'pg';
import sharp from 'sharp';

const devUrl = process.env.DATABASE_URL ?? 'postgres://twin:twin@localhost:5434/twin';
{
  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  await admin.query('drop database if exists twin_test_copresence with (force)');
  await admin.query('create database twin_test_copresence');
  await admin.end();
}
process.env.DATABASE_URL = devUrl.replace(/\/[^/]+$/, '/twin_test_copresence');
process.env.AWS_REGION ??= 'us-east-1';
process.env.COLLECTION_ID ??= 'fake';
process.env.TOKEN_SECRET = 'copresence-test';

const { rekognition } = await import('../src/aws.js');
const { migrate, pool } = await import('../src/db.js');
const { hashSecret } = await import('../src/lib/secrets.js');
const { openClaim, move, getClaim } = await import('../src/services/claims.js');
const cp = await import('../src/services/copresence.js');
await migrate();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
};
async function expectError(p: Promise<unknown>, code: string) {
  try { await p; return false; } catch (e) { return (e as { code?: string }).code === code; }
}

// ---- fake Rekognition -------------------------------------------------------
type Fake = { liveConfidence: number; detect: () => unknown[]; searchFaceIds: () => string[] };
const fake: Fake = { liveConfidence: 99, detect: () => [], searchFaceIds: () => [] };
let indexed = 0;
const deleted: string[] = [];
(rekognition as unknown as { send: (c: { constructor: { name: string }; input: any }) => Promise<unknown> }).send =
  async (cmd) => {
    switch (cmd.constructor.name) {
      case 'CreateFaceLivenessSessionCommand':
        return { SessionId: crypto.randomUUID() };
      case 'GetFaceLivenessSessionResultsCommand':
        return { Status: 'SUCCEEDED', Confidence: fake.liveConfidence, ReferenceImage: { Bytes: new Uint8Array([1, 2, 3]) } };
      case 'SearchFacesByImageCommand':
        return { FaceMatches: fake.searchFaceIds().map((id) => ({ Face: { FaceId: id }, Similarity: 99.5 })) };
      case 'DetectFacesCommand':
        return { FaceDetails: fake.detect() };
      case 'IndexFacesCommand':
        return { FaceRecords: [{ Face: { FaceId: `new-face-${++indexed}` } }] };
      case 'DeleteFacesCommand':
        deleted.push(...cmd.input.FaceIds);
        return {};
      default:
        throw new Error(`fake rekognition: unexpected ${cmd.constructor.name}`);
    }
  };
const faceDetail = (left: number, pose: Record<string, number>) => ({
  Confidence: 99.9,
  BoundingBox: { Left: left, Top: 0.3, Width: 0.2, Height: 0.26 },
  Pose: { Yaw: 0, Roll: 0, Pitch: 0, ...pose },
});
const POSE_ANGLES: Record<string, Record<string, number>> = { turn: { Yaw: 32 }, tilt: { Roll: 24 }, nod: { Pitch: 22 } };
const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#888' } }).jpeg().toBuffer();

// ---- fixtures -----------------------------------------------------------------
async function owner(name: string, faceId: string) {
  const id = (await pool.query(`insert into identities (display_name) values ($1) returning id`, [name])).rows[0].id as string;
  await pool.query(`insert into faces values ($1, $2, 'registration')`, [faceId, id]);
  await pool.query(`insert into credentials (identity_id, recovery_code_hash) values ($1, $2)`, [id, await hashSecret('AAAA-BBBB-CCCC')]);
  return id;
}
async function confirmedClaim(targetId: string, claimant: string) {
  const { claim: c } = await openClaim([targetId], claimant);
  await move(c.id, ['open'], 'owner_confirmed', { auditType: 'test.confirm' });
  return c.id;
}
async function bothLive(claimId: string) {
  for (const role of ['owner', 'claimant'] as const) {
    const s = await cp.startClaimLiveness(claimId, role);
    await cp.finishClaimLiveness(claimId, role, s);
  }
}

try {
  const A = await owner('Alice', 'face-A');
  fake.searchFaceIds = () => ['face-A'];

  // ---- liveness phase
  const c1 = await confirmedClaim(A, 'Bella');
  const sOwner = await cp.startClaimLiveness(c1, 'owner');
  check('liveness session bound to role cannot be spent as the other role',
    await expectError(cp.finishClaimLiveness(c1, 'claimant', sOwner), 'liveness_invalid'));
  const sOwner2 = await cp.startClaimLiveness(c1, 'owner');
  let r = await cp.finishClaimLiveness(c1, 'owner', sOwner2);
  check('owner liveness passes, claim still owner_confirmed', r.liveness.owners === 1 && !r.liveness.claimant && r.claim.state === 'owner_confirmed', r);

  fake.searchFaceIds = () => [];
  const sStranger = await cp.startClaimLiveness(c1, 'claimant');
  check('claimant whose face does not match the owner is rejected',
    await expectError(cp.finishClaimLiveness(c1, 'claimant', sStranger), 'face_not_target'));
  fake.searchFaceIds = () => ['face-A'];

  const sClaimant = await cp.startClaimLiveness(c1, 'claimant');
  r = await cp.finishClaimLiveness(c1, 'claimant', sClaimant);
  check('both passed -> both_live', r.claim.state === 'both_live', r);
  check('spent session cannot be replayed',
    (await expectError(cp.finishClaimLiveness(c1, 'claimant', sClaimant), 'liveness_invalid')) ||
      (await expectError(cp.finishClaimLiveness(c1, 'claimant', sClaimant), 'claimant_done')));
  check('a fresh claimant session after passing is refused (claimant_done)',
    await expectError(cp.startClaimLiveness(c1, 'claimant').then((s) => cp.finishClaimLiveness(c1, 'claimant', s)), 'claimant_done'));

  // ---- joint capture: PASS
  let ch = await cp.issueChallenge(c1);
  check('challenge issued -> challenged', ch.claim.state === 'challenged' && ch.challenge.slots[0] !== ch.challenge.slots[1], ch);
  const poses = ch.challenge.slots;
  fake.detect = () => [faceDetail(0.15, POSE_ANGLES[poses[0]!]!), faceDetail(0.6, POSE_ANGLES[poses[1]!]!)];
  const out = await cp.submitJointCapture(c1, image);
  check('two faces, right poses, both match owner -> pass', out.result === 'pass', out.result === 'fail' ? out.reasons : '');
  if (out.result === 'pass') {
    const g = await pool.query('select group_id, identity_id from group_members order by joined_at');
    check('claim resolved with result identity', out.claim.state === 'resolved' && !!out.claim.resultIdentityId, out.claim);
    check('both identities in one new collision group', g.rowCount === 2 && g.rows[0].group_id === g.rows[1].group_id, g.rows);
    const f = await pool.query(`select source from faces where identity_id = $1`, [out.identity.id]);
    check('claimant face indexed with source co_presence', f.rows[0]?.source === 'co_presence', f.rows);
    check('claimant gets a recovery code', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(out.recoveryCode), out.recoveryCode);
  }
  check('challenge cannot be reused after resolve', await expectError(cp.submitJointCapture(c1, image), 'bad_claim_state'));

  // ---- joint capture: FAIL x3 -> review
  const B = await owner('Carol', 'face-C');
  fake.searchFaceIds = () => ['face-C'];
  const c2 = await confirmedClaim(B, 'Dana');
  await bothLive(c2);
  fake.detect = () => [faceDetail(0.4, { Yaw: 30 })]; // one person alone
  for (let i = 1; i <= 3; i++) {
    await cp.issueChallenge(c2);
    const o = await cp.submitJointCapture(c2, image);
    if (i < 3) check(`alone, attempt ${i} -> fail, back to both_live, ${3 - i} left`, o.result === 'fail' && o.claim.state === 'both_live' && o.attemptsLeft === 3 - i, o);
    else check('alone, attempt 3 -> review (co_presence_failed)', o.result === 'fail' && o.claim.state === 'review' && o.claim.reviewReason === 'co_presence_failed', o.claim);
  }

  // ---- photo of yourself next to you: second face cannot follow its pose
  const C = await owner('Erin', 'face-E');
  fake.searchFaceIds = () => ['face-E'];
  const c3 = await confirmedClaim(C, 'Fay');
  await bothLive(c3);
  ch = await cp.issueChallenge(c3);
  const p3 = ch.challenge;
  const liveSlot = p3.claimantSlot === 0 ? 1 : 0; // the real person; the other slot is a photo
  fake.detect = () => [
    faceDetail(0.15, liveSlot === 0 ? POSE_ANGLES[p3.slots[0]!]! : {}),
    faceDetail(0.6, liveSlot === 1 ? POSE_ANGLES[p3.slots[1]!]! : {}),
  ];
  let o = await cp.submitJointCapture(c3, image);
  check('you + a printed photo of you -> fail on pose', o.result === 'fail' && o.reasons.some((x) => x.includes('did not')), o.result === 'fail' ? o.reasons : o);

  // ---- second face is somebody with their own identity
  ch = await cp.issueChallenge(c3);
  const p3b = ch.challenge.slots;
  fake.detect = () => [faceDetail(0.15, POSE_ANGLES[p3b[0]!]!), faceDetail(0.6, POSE_ANGLES[p3b[1]!]!)];
  let n = 0;
  fake.searchFaceIds = () => (++n === 1 ? ['face-E'] : ['face-A']); // second crop matches Alice
  o = await cp.submitJointCapture(c3, image);
  check('a face matching a different identity -> fail', o.result === 'fail' && o.reasons.some((x) => x.includes('different identity')), o.result === 'fail' ? o.reasons : o);
  fake.searchFaceIds = () => ['face-E'];

  // ---- expired challenge
  const C4 = await owner('Gina', 'face-G');
  fake.searchFaceIds = () => ['face-G'];
  const c4 = await confirmedClaim(C4, 'Hana');
  await bothLive(c4);
  await cp.issueChallenge(c4);
  await pool.query(`update claims set challenge_expires_at = now() - interval '1 second' where id = $1`, [c4]);
  check('expired challenge -> 410', await expectError(cp.submitJointCapture(c4, image), 'challenge_expired'));

  // ---- parallel submits: only one capture per challenge
  const ch4 = await cp.issueChallenge(c4);
  fake.detect = () => [faceDetail(0.15, POSE_ANGLES[ch4.challenge.slots[0]!]!), faceDetail(0.6, POSE_ANGLES[ch4.challenge.slots[1]!]!)];
  const both = await Promise.allSettled([cp.submitJointCapture(c4, image), cp.submitJointCapture(c4, image)]);
  const ok = both.filter((b) => b.status === 'fulfilled').length;
  check('two parallel captures on one challenge: exactly one runs', ok === 1, both.map((b) => b.status));

  // ---- stale liveness
  const C5 = await owner('Iris', 'face-I');
  fake.searchFaceIds = () => ['face-I'];
  const c5 = await confirmedClaim(C5, 'Jo');
  await bothLive(c5);
  await pool.query(`update liveness_sessions set created_at = now() - interval '11 minutes' where claim_id = $1`, [c5]);
  check('liveness older than 10 min -> liveness_stale', await expectError(cp.issueChallenge(c5), 'liveness_stale'));
  check('...and claim goes back to owner_confirmed', (await getClaim(c5)).state === 'owner_confirmed');

  // ---- third lookalike: claim against the Alice+Bella group, all 3 in one frame
  const groupClaim = (await openClaim([A], 'Zed')).claim;
  check('claim against a group member targets the whole group', !!groupClaim.targetGroupId);
  await move(groupClaim.id, ['open'], 'owner_confirmed', { auditType: 'test.confirm' });
  fake.searchFaceIds = () => ['face-A'];
  let st = await cp.livenessStatus(groupClaim.id);
  check('group of 2: needs 2 owner liveness checks + claimant', st.ownersRequired === 2 && !st.complete, st);
  for (const role of ['owner', 'owner', 'claimant'] as const) {
    const s = await cp.startClaimLiveness(groupClaim.id, role);
    await cp.finishClaimLiveness(groupClaim.id, role, s);
  }
  st = await cp.livenessStatus(groupClaim.id);
  check('...after 2 owners + claimant -> complete, both_live', st.complete && (await getClaim(groupClaim.id)).state === 'both_live', st);
  check('a 3rd owner check is refused', await expectError(cp.startClaimLiveness(groupClaim.id, 'owner').then((s) => cp.finishClaimLiveness(groupClaim.id, 'owner', s)), 'owners_done'));
  const ch3 = await cp.issueChallenge(groupClaim.id);
  check('challenge has 3 slots with 3 different poses', ch3.challenge.slots.length === 3 && new Set(ch3.challenge.slots).size === 3, ch3.challenge);
  fake.detect = () => [faceDetail(0.15, POSE_ANGLES[ch3.challenge.slots[0]!]!)  , faceDetail(0.6, POSE_ANGLES[ch3.challenge.slots[1]!]!)];
  let o3 = await cp.submitJointCapture(groupClaim.id, image);
  check('only 2 of 3 people in frame -> fail', o3.result === 'fail' && o3.reasons[0]!.includes('Exactly 3'), o3.result === 'fail' ? o3.reasons : o3);
  const ch3b = await cp.issueChallenge(groupClaim.id);
  fake.detect = () => ch3b.challenge.slots.map((p, i) => ({ ...faceDetail(0.05 + i * 0.32, POSE_ANGLES[p]!), BoundingBox: { Left: 0.05 + i * 0.32, Top: 0.3, Width: 0.18, Height: 0.24 } }));
  let n3 = 0;
  fake.searchFaceIds = () => (++n3 % 2 ? ['face-A'] : ['new-face-1']); // owners match Alice or Bella's face
  o3 = await cp.submitJointCapture(groupClaim.id, image);
  check('all 3 in frame, own poses, all match members -> pass', o3.result === 'pass', o3.result === 'fail' ? o3.reasons : '');
  const size = (await pool.query('select count(*)::int n from group_members where group_id = $1', [groupClaim.targetGroupId])).rows[0].n;
  check('third person joined the existing group (size 3)', size === 3, size);
  check('a 4th lookalike is refused: group_full', await expectError(openClaim([A], 'Fourth'), 'group_full'));
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
