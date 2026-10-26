import { randomInt } from 'node:crypto';

/**
 * Pure rules for the joint frame. No AWS, no DB: unit-testable with
 * synthetic face data (test/copresence-rules.test.ts).
 *
 * Poses are sign-free on purpose: "turn" means |yaw| is large, whichever
 * way. That avoids guessing Rekognition's left/right sign conventions and
 * camera mirroring, and a flat photo still cannot do it on command.
 */
export const POSES = ['turn', 'tilt', 'nod'] as const;
export type Pose = (typeof POSES)[number];
export type Role = 'owner' | 'claimant';

export const POSE_TEXT: Record<Pose, string> = {
  turn: 'turn your head to the side (left or right)',
  tilt: 'tilt your head toward a shoulder',
  nod: 'look up or down',
};

/** Max people in one joint frame: every person must get a DIFFERENT pose. */
export const MAX_PEOPLE = POSES.length;

/**
 * slots = people from left to right (screen side, camera NOT mirrored);
 * each slot has its own pose; one slot is where the claimant must stand.
 */
export type Challenge = {
  slots: Pose[];
  claimantSlot: number;
  issuedAt: string;
};

/** Human names for positions, e.g. ["left", "right"] or ["left", "middle", "right"]. */
export function positionNames(n: number): string[] {
  if (n === 2) return ['left', 'right'];
  if (n === 3) return ['left', 'middle', 'right'];
  return Array.from({ length: n }, (_, i) => `#${i + 1} from left`);
}

/** Random distinct poses (a shuffled subset) and a random claimant position. */
export function newChallenge(people = 2): Challenge {
  if (people < 2 || people > MAX_PEOPLE) throw new Error(`co-presence supports 2..${MAX_PEOPLE} people`);
  const pool = [...POSES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return { slots: pool.slice(0, people), claimantSlot: randomInt(people), issuedAt: new Date().toISOString() };
}

export type PoseAngles = { yaw: number; roll: number; pitch: number };

/** Each pose needs its own movement AND the other movements kept small. */
export function poseMatches(pose: Pose, a: PoseAngles): boolean {
  const yaw = Math.abs(a.yaw);
  const roll = Math.abs(a.roll);
  const pitch = Math.abs(a.pitch);
  switch (pose) {
    case 'turn':
      return yaw >= 20 && roll < 15;
    case 'tilt':
      return roll >= 15 && yaw < 20;
    case 'nod':
      return pitch >= 15 && yaw < 20 && roll < 15;
  }
}

/** The bits of a Rekognition FaceDetail the rules need. Box values are 0..1 of the image. */
export type DetectedFace = {
  confidence: number;
  box: { left: number; top: number; width: number; height: number };
  pose: PoseAngles;
};

export type FaceCheck = {
  slot: number;
  position: string;
  role: Role;
  expectedPose: Pose;
  pose: PoseAngles;
  poseOk: boolean;
  box: DetectedFace['box'];
};

export type FrameVerdict =
  | { ok: true; faces: FaceCheck[] }
  | { ok: false; reasons: string[]; faces: FaceCheck[] };

export const RULES = {
  minDetectionConfidence: 90,
  minFaceWidth: 0.08, // each face at least 8% of the frame width
  maxSizeRatio: 2.0, // a phone screen or small print shows a much smaller face
};

/**
 * Geometry + pose rules on DetectFaces output. Identity (does each face
 * match a member, and only members) is checked afterwards with the crops,
 * because that needs Rekognition search calls.
 */
export function checkFrame(detected: DetectedFace[], challenge: Challenge): FrameVerdict {
  const people = challenge.slots.length;
  const faces = detected.filter((f) => f.confidence >= RULES.minDetectionConfidence);
  if (faces.length !== people) {
    return {
      ok: false,
      reasons: [`Exactly ${people} faces are required in the frame; found ${faces.length}.`],
      faces: [],
    };
  }

  const names = positionNames(people);
  const sorted = [...faces].sort((a, b) => a.box.left - b.box.left);
  const checks: FaceCheck[] = sorted.map((f, slot) => {
    const expectedPose = challenge.slots[slot]!;
    return {
      slot,
      position: names[slot]!,
      role: slot === challenge.claimantSlot ? 'claimant' : 'owner',
      expectedPose,
      pose: f.pose,
      poseOk: poseMatches(expectedPose, f.pose),
      box: f.box,
    };
  });

  const reasons: string[] = [];
  for (const c of checks) {
    if (c.box.width < RULES.minFaceWidth) reasons.push(`The ${c.position} face is too small; step closer.`);
    if (!c.poseOk) reasons.push(`The ${c.position} person did not ${POSE_TEXT[c.expectedPose]}.`);
  }
  const widths = sorted.map((f) => f.box.width);
  const ratio = Math.max(...widths) / Math.min(...widths);
  if (ratio > RULES.maxSizeRatio) {
    reasons.push(`The faces differ too much in size (${ratio.toFixed(1)}x); stand side by side.`);
  }

  return reasons.length ? { ok: false, reasons, faces: checks } : { ok: true, faces: checks };
}

/** Pixel crop with 25% margin, clamped to the image. */
export function cropRect(box: DetectedFace['box'], imgW: number, imgH: number) {
  const mx = box.width * 0.25;
  const my = box.height * 0.25;
  const left = Math.max(0, Math.floor((box.left - mx) * imgW));
  const top = Math.max(0, Math.floor((box.top - my) * imgH));
  const right = Math.min(imgW, Math.ceil((box.left + box.width + mx) * imgW));
  const bottom = Math.min(imgH, Math.ceil((box.top + box.height + my) * imgH));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
