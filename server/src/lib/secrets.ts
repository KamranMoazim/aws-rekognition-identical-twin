import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Built-in scrypt, no native deps. Format: scrypt$<salt>$<key>. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scryptAsync(secret, Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

// No 0/O, 1/I/L: easy to read back from a screen or paper.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** e.g. "K7QD-9MXA-T3PW". Shown once, stored hashed. Stands in for the client's identity certificate. */
export function newRecoveryCode(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}
