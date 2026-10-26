export type Identity = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  groupId: string | null;
};

export type ClaimView = {
  id: string;
  state: 'open' | 'owner_confirmed' | 'both_live' | 'challenged' | 'resolved' | 'review' | 'expired' | 'cancelled';
  claimantName: string;
  nextStep: string;
  expiresAt: string;
  createdAt: string;
  ownerConfirmedAt: string | null;
  reviewReason: string | null;
  closedAt: string | null;
  attemptCount: number;
};

export type Role = 'owner' | 'claimant';
export type Pose = 'turn' | 'tilt' | 'nod';

export type ChallengeView = {
  expiresAt: string;
  claimantSide: 'left' | 'right';
  instructions: { left: string; right: string };
  poses: { left: Pose; right: Pose };
};

export type FaceResult = {
  side: 'left' | 'right';
  role: Role;
  expectedPose: Pose;
  pose: { yaw: number; roll: number; pitch: number };
  poseOk: boolean;
  similarity: number | null;
  identityOk: boolean;
  boxWidth: number;
};

export type JointResult =
  | { result: 'pass'; state: string; identity: Identity; recoveryCode: string; sessionToken: string; faces: FaceResult[] }
  | { result: 'fail'; state: string; reasons: string[]; attemptsLeft: number; faces: FaceResult[] };

export const ACTIVE_CLAIM_STATES: ClaimView['state'][] = ['open', 'owner_confirmed', 'both_live', 'challenged'];

export type ApiError = { error: string; message: string; [k: string]: unknown };

/** Throws the server's JSON error body (with .status) on non-2xx. */
async function call<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? res.statusText), { status: res.status, body });
  return body as T;
}

const post = <T>(path: string, data: unknown, token?: string | null) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(data) }, token);

export const api = {
  config: () => call<{ region: string; identityPoolId: string }>('/config'),
  livenessSession: (purpose: 'register' | 'login') =>
    post<{ sessionId: string }>('/liveness/sessions', { purpose }),
  register: (sessionId: string, displayName: string) =>
    post<{ status: 'registered'; identity: Identity; recoveryCode: string; sessionToken: string }>('/register', {
      sessionId,
      displayName,
    }),
  login: (sessionId: string) =>
    post<{ status: 'logged_in'; identity: Identity; sessionToken: string }>('/login', { sessionId }),
  me: (token: string) => call<{ identity: Identity }>('/me', {}, token),

  // Claims: the claimant (no account) uses a claim token, the owner uses their session.
  openClaim: (matchToken: string, claimantName: string) =>
    post<{ claim: ClaimView; claimToken: string }>('/claims', { matchToken, claimantName }),
  claimAsClaimant: (id: string, claimToken: string) =>
    call<{ claim: ClaimView }>(`/claims/${id}`, {}, null, { 'x-claim-token': claimToken }),
  cancelClaim: (id: string, claimToken: string) =>
    call<{ claim: ClaimView }>(`/claims/${id}`, { method: 'DELETE' }, null, { 'x-claim-token': claimToken }),
  myClaims: (token: string) => call<{ claims: ClaimView[] }>('/me/claims', {}, token),
  ownerConfirm: (id: string, recoveryCode: string, token: string) =>
    post<{ claim: ClaimView }>(`/claims/${id}/owner-confirm`, { recoveryCode }, token),
  ownerDecline: (id: string, token: string) => post<{ claim: ClaimView }>(`/claims/${id}/owner-decline`, {}, token),
  ownerCancel: (id: string, token: string) => post<{ claim: ClaimView }>(`/claims/${id}/owner-cancel`, {}, token),

  // Co-presence: runs on the claimant's device, every call carries the claim token.
  claimLiveness: (id: string, ct: string) =>
    call<{ liveness: Record<Role, boolean> }>(`/claims/${id}/liveness`, {}, null, { 'x-claim-token': ct }),
  claimLivenessSession: (id: string, role: Role, ct: string) =>
    call<{ sessionId: string }>(`/claims/${id}/liveness-session`, { method: 'POST', body: JSON.stringify({ role }) }, null, {
      'x-claim-token': ct,
    }),
  claimLivenessDone: (id: string, role: Role, sessionId: string, ct: string) =>
    call<{ state: string; liveness: Record<Role, boolean> }>(
      `/claims/${id}/liveness`,
      { method: 'POST', body: JSON.stringify({ role, sessionId }) },
      null,
      { 'x-claim-token': ct },
    ),
  challenge: (id: string, ct: string) =>
    call<ChallengeView>(`/claims/${id}/challenge`, { method: 'POST' }, null, { 'x-claim-token': ct }),
  jointCapture: (id: string, image: string, ct: string) =>
    call<JointResult>(`/claims/${id}/joint-capture`, { method: 'POST', body: JSON.stringify({ image }) }, null, {
      'x-claim-token': ct,
    }),
};

/** Pull the server's error body out of a thrown fetch error (keeps every field, e.g. matchToken). */
export function errorBody(err: unknown): ApiError {
  const e = err as { body?: Record<string, unknown>; message?: string };
  if (e.body && Object.keys(e.body).length) {
    return {
      ...e.body,
      error: String(e.body.error ?? e.body.status ?? 'error'),
      message: String(e.body.message ?? e.message ?? ''),
    };
  }
  return { error: 'network', message: e.message ?? String(err) };
}
