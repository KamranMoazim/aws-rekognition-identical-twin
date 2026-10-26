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
export type Side = 'left' | 'right';

export const POSE_TEXT: Record<Pose, string> = {
  turn: 'turn your head to the side (left or right)',
  tilt: 'tilt your head toward a shoulder',
  nod: 'look up or down',
};

export type Challenge = {
  claimantSide: Side; // where the claimant must stand (screen side, camera NOT mirrored)
  left: Pose;
  right: Pose;
  issuedAt: string;
};

/** Random sides and two DIFFERENT poses, so neither person can copy the other. */
export function newChallenge(): Challenge {
  const first = POSES[randomInt(POSES.length)]!;
  const rest = POSES.filter((p) => p !== first);
  const second = rest[randomInt(rest.length)]!;
  return {
    claimantSide: randomInt(2) === 0 ? 'left' : 'right',
    left: first,
    right: second,
    issuedAt: new Date().toISOString(),
  };
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
  side: Side;
  role: 'owner' | 'claimant';
  expectedPose: Pose;
  pose: PoseAngles;
  poseOk: boolean;
  box: DetectedFace['box'];
};

export type FrameVerdict =
  | { ok: true; faces: [FaceCheck, FaceCheck] }
  | { ok: false; reasons: string[]; faces: FaceCheck[] };

export const RULES = {
  minDetectionConfidence: 90,
  minFaceWidth: 0.08, // each face at least 8% of the frame width
  maxSizeRatio: 2.0, // a phone screen or small print shows a much smaller face
};

/**
 * Geometry + pose rules on DetectFaces output. Identity (does each face
 * match the owner, and only the owner) is checked afterwards with the
 * crops returned here, because that needs Rekognition search calls.
 */
export function checkFrame(detected: DetectedFace[], challenge: Challenge): FrameVerdict {
  const faces = detected.filter((f) => f.confidence >= RULES.minDetectionConfidence);
  if (faces.length !== 2) {
    return {
      ok: false,
      reasons: [`Exactly 2 faces are required in the frame; found ${faces.length}.`],
      faces: [],
    };
  }

  const [l, r] = [...faces].sort((a, b) => a.box.left - b.box.left) as [DetectedFace, DetectedFace];
  const make = (f: DetectedFace, side: Side): FaceCheck => {
    const expectedPose = side === 'left' ? challenge.left : challenge.right;
    return {
      side,
      role: challenge.claimantSide === side ? 'claimant' : 'owner',
      expectedPose,
      pose: f.pose,
      poseOk: poseMatches(expectedPose, f.pose),
      box: f.box,
    };
  };
  const checks: [FaceCheck, FaceCheck] = [make(l, 'left'), make(r, 'right')];

  const reasons: string[] = [];
  for (const c of checks) {
    if (c.box.width < RULES.minFaceWidth) reasons.push(`The ${c.side} face is too small; step closer.`);
    if (!c.poseOk) reasons.push(`The ${c.side} person did not ${POSE_TEXT[c.expectedPose]}.`);
  }
  const ratio = Math.max(l.box.width, r.box.width) / Math.min(l.box.width, r.box.width);
  if (ratio > RULES.maxSizeRatio) {
    reasons.push(`The two faces differ too much in size (${ratio.toFixed(1)}x); stand side by side.`);
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
