// Step 4 unit tests: joint-frame rules with synthetic DetectFaces output.
// No AWS, no DB. This is how the PASS path is tested without a second person.
// Run: npm run test:rules
import { checkFrame, cropRect, newChallenge, poseMatches, type Challenge, type DetectedFace } from '../src/services/copresence-rules.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(extra)}`);
};

const face = (left: number, width: number, pose: Partial<DetectedFace['pose']> = {}, confidence = 99.9): DetectedFace => ({
  confidence,
  box: { left, top: 0.3, width, height: width * 1.3 },
  pose: { yaw: 0, roll: 0, pitch: 0, ...pose },
});
const ch: Challenge = { slots: ['turn', 'tilt'], claimantSlot: 1, issuedAt: new Date().toISOString() };

// poses
check('turn: yaw 30 ok', poseMatches('turn', { yaw: 30, roll: 2, pitch: 0 }));
check('turn: yaw -30 ok (sign-free)', poseMatches('turn', { yaw: -30, roll: 2, pitch: 0 }));
check('turn: straight face fails', !poseMatches('turn', { yaw: 3, roll: 1, pitch: 2 }));
check('tilt: roll 20 ok', poseMatches('tilt', { yaw: 5, roll: 20, pitch: 0 }));
check('tilt: turned head is not a tilt', !poseMatches('tilt', { yaw: 35, roll: 20, pitch: 0 }));
check('nod: pitch -20 ok', poseMatches('nod', { yaw: 4, roll: 3, pitch: -20 }));
check('nod: straight fails', !poseMatches('nod', { yaw: 0, roll: 0, pitch: 5 }));

// challenge
const many = Array.from({ length: 200 }, () => newChallenge(2));
check('challenge poses always differ', many.every((c) => c.slots[0] !== c.slots[1]));
check('claimant side is random', new Set(many.map((c) => c.claimantSlot)).size === 2);
const three = Array.from({ length: 200 }, () => newChallenge(3));
check('3 people: all three poses, all different', three.every((c) => new Set(c.slots).size === 3));
check('3 people: claimant can be in any slot', new Set(three.map((c) => c.claimantSlot)).size === 3);
let threw = false;
try { newChallenge(4); } catch { threw = true; }
check('4 people refused (not enough distinct poses)', threw);

// frames
let v = checkFrame([face(0.15, 0.2, { yaw: 30 }), face(0.6, 0.2, { roll: 22 })], ch);
check('two people, both follow their pose -> ok', v.ok, v);
check('roles follow claimantSlot', v.ok && v.faces[1]!.role === 'claimant' && v.faces[0]!.role === 'owner', v);

v = checkFrame([face(0.6, 0.2, { roll: 22 }), face(0.15, 0.2, { yaw: 30 })], ch);
check('order of DetectFaces output does not matter (sorted by position)', v.ok, v);

v = checkFrame([face(0.4, 0.25, { yaw: 30 })], ch);
check('one person alone -> fail (1 face)', !v.ok && v.reasons[0]!.includes('found 1'), v);

const ch3: Challenge = { slots: ['nod', 'turn', 'tilt'], claimantSlot: 0, issuedAt: new Date().toISOString() };
v = checkFrame([face(0.7, 0.18, { roll: 22 }), face(0.05, 0.18, { pitch: 20 }), face(0.38, 0.18, { yaw: 30 })], ch3);
check('three people, each own pose -> ok, claimant on the left', v.ok && v.faces[0]!.role === 'claimant' && v.faces[1]!.position === 'middle', v);
v = checkFrame([face(0.05, 0.18, { pitch: 20 }), face(0.38, 0.18, { yaw: 30 })], ch3);
check('three-person challenge with two faces -> fail', !v.ok && v.reasons[0]!.includes('Exactly 3'), v);

v = checkFrame([face(0.1, 0.2, { yaw: 30 }), face(0.4, 0.2, { roll: 22 }), face(0.7, 0.2)], ch);
check('three faces -> fail', !v.ok && v.reasons[0]!.includes('found 3'), v);

v = checkFrame([face(0.15, 0.2, { yaw: 30 }), face(0.6, 0.2, { roll: 22 }, 60)], ch);
check('low-confidence second face does not count', !v.ok && v.reasons[0]!.includes('found 1'), v);

v = checkFrame([face(0.15, 0.2, { yaw: 30 }), face(0.6, 0.2)], ch);
check('photo next to you (cannot tilt on command) -> fail', !v.ok && v.reasons.some((r) => r.includes('right person')), v);

v = checkFrame([face(0.15, 0.22, { yaw: 30 }), face(0.6, 0.07, { roll: 22 })], ch);
check('tiny second face (phone screen) -> too small + size ratio', !v.ok && v.reasons.some((r) => r.includes('too small')) && v.reasons.some((r) => r.includes('differ too much')), v);

v = checkFrame([face(0.15, 0.2, { roll: 22 }), face(0.6, 0.2, { yaw: 30 })], ch);
check('people swapped poses -> fail both', !v.ok && v.reasons.length === 2, v);

// crop
const c = cropRect({ left: 0.9, top: 0.9, width: 0.2, height: 0.2 }, 1000, 500);
check('crop is clamped to the image', c.left + c.width <= 1000 && c.top + c.height <= 500, c);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
