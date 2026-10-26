import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

/**
 * Small HMAC-signed tokens: "<base64url json>.<base64url sig>".
 * kind keeps one token type from being replayed as another.
 */
export type TokenKind = 'session' | 'match' | 'claim' | 'pin';

type Envelope = { kind: TokenKind; exp: number };

const b64url = (buf: Buffer) => buf.toString('base64url');
const sign = (body: string) => b64url(createHmac('sha256', config.tokenSecret).update(body).digest());

export function issueToken<T extends object>(kind: TokenKind, payload: T, ttlSeconds: number): string {
  const envelope = { ...payload, kind, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(Buffer.from(JSON.stringify(envelope)));
  return `${body}.${sign(body)}`;
}

export function readToken<T extends object>(token: string | undefined, kind: TokenKind): T & Envelope {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) throw new HttpError(401, 'bad_token', 'Missing or malformed token');
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new HttpError(401, 'bad_token', 'Token signature invalid');
  }
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & Envelope;
  if (data.kind !== kind) throw new HttpError(401, 'bad_token', 'Wrong token type');
  if (data.exp < Date.now() / 1000) throw new HttpError(401, 'token_expired', 'Token expired');
  return data;
}
