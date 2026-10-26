export type Identity = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  groupId: string | null;
};

export type ApiError = { error: string; message: string; [k: string]: unknown };

/** Throws the server's JSON error body (with .status) on non-2xx. */
async function call<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
};

/** Pull the server's error body out of a thrown fetch error. */
export function errorBody(err: unknown): ApiError {
  const e = err as { body?: ApiError; message?: string };
  return e.body?.error ? e.body : { error: 'network', message: e.message ?? String(err) };
}
