import type pg from 'pg';
import { pool, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { hashSecret, newRecoveryCode, verifySecret } from '../lib/secrets.js';

/**
 * PINs exist to pick ONE member of a collision group after a face match
 * found the group. Rules:
 *  - 6 digits, not trivially guessable
 *  - unique inside the group (checked at set time, group row locked)
 *  - wrong PINs throttle the GROUP for a while; they never lock a member,
 *    so one twin cannot lock the other out of their account
 */
export const PIN_LENGTH = 6;
export const GROUP_MAX_FAILS = 5;
export const GROUP_WINDOW_MINUTES = 15;

export function validatePin(pin: string): void {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new HttpError(400, 'pin_format', `PIN must be exactly ${PIN_LENGTH} digits.`);
  }
  const digits = [...pin].map(Number);
  const allSame = digits.every((d) => d === digits[0]);
  const step = (s: number) => digits.every((d, i) => i === 0 || d === (digits[i - 1]! + s + 10) % 10);
  if (allSame || step(1) || step(-1)) {
    throw new HttpError(400, 'pin_weak', 'PIN is too easy to guess (repeated or sequential digits).');
  }
}

type Member = { identity_id: string; pin_hash: string | null; recovery_code_hash: string };

async function membersOf(groupIds: string[], db: Pick<pg.PoolClient, 'query'> = pool): Promise<Member[]> {
  const r = await db.query<Member>(
    `select gm.identity_id, c.pin_hash, c.recovery_code_hash
       from group_members gm join credentials c on c.identity_id = gm.identity_id
      where gm.group_id = any($1)`,
    [groupIds],
  );
  return r.rows;
}

/** Does any member hold this PIN? (hashes are salted, so compare one by one) */
async function findByPin(members: Member[], pin: string): Promise<Member[]> {
  const hits: Member[] = [];
  for (const m of members) if (m.pin_hash && (await verifySecret(pin, m.pin_hash))) hits.push(m);
  return hits;
}

/**
 * Set or change a PIN. Locks the identity's group so two members setting
 * the same PIN at the same moment cannot both succeed.
 */
export async function setPin(
  identityId: string,
  pin: string,
  opts: { currentPin?: string; viaRecovery?: boolean } = {},
): Promise<void> {
  validatePin(pin);
  const verdict = await tx(async (c) => {
    const group = await c.query<{ group_id: string }>(
      `select g.id as group_id from group_members gm join collision_groups g on g.id = gm.group_id
        where gm.identity_id = $1 for update of g`,
      [identityId],
    );
    const cred = (await c.query<{ pin_hash: string | null }>('select pin_hash from credentials where identity_id = $1 for update', [identityId])).rows[0];
    if (!cred) return 'no_credentials' as const;
    // Changing a PIN needs the current one, unless the recovery code was just verified.
    if (cred.pin_hash && !opts.viaRecovery) {
      if (!opts.currentPin || !(await verifySecret(opts.currentPin, cred.pin_hash))) return 'wrong_current' as const;
    }
    if (group.rowCount) {
      const others = (await membersOf([group.rows[0]!.group_id], c)).filter((m) => m.identity_id !== identityId);
      if ((await findByPin(others, pin)).length) return 'pin_taken' as const;
    }
    await c.query('update credentials set pin_hash = $2, pin_set_at = now() where identity_id = $1', [identityId, await hashSecret(pin)]);
    await audit(opts.viaRecovery ? 'pin.reset' : cred.pin_hash ? 'pin.changed' : 'pin.set', { identityId }, c);
    return 'ok' as const;
  });
  if (verdict === 'ok') return;
  if (verdict === 'no_credentials') throw new HttpError(404, 'no_credentials', 'No credentials for identity');
  if (verdict === 'wrong_current') throw new HttpError(403, 'wrong_current_pin', 'Current PIN is wrong.');
  // Same message whatever the reason, so it reveals as little as possible about the other member.
  throw new HttpError(409, 'pin_taken', 'Choose a different PIN.');
}

/** Rolling-window throttle on failed PIN / recovery attempts for these groups. */
async function attemptsLeft(groupIds: string[]): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `select count(*)::int as n from group_login_attempts
      where group_id = any($1) and at > now() - make_interval(mins => $2)`,
    [groupIds, GROUP_WINDOW_MINUTES],
  );
  return Math.max(0, GROUP_MAX_FAILS - r.rows[0]!.n);
}

async function assertNotThrottled(groupIds: string[]): Promise<void> {
  if ((await attemptsLeft(groupIds)) === 0) {
    throw new HttpError(429, 'group_throttled', `Too many wrong attempts for this face. Try again in up to ${GROUP_WINDOW_MINUTES} minutes.`);
  }
}

async function recordFailure(groupIds: string[], kind: 'pin' | 'recovery'): Promise<number> {
  for (const g of groupIds) await pool.query('insert into group_login_attempts (group_id, kind) values ($1, $2)', [g, kind]);
  await audit(`group_login.${kind}_failed`, { data: { groupIds } });
  return attemptsLeft(groupIds);
}

/** Face found the group(s); the PIN picks the member. */
export async function loginWithPin(groupIds: string[], pin: string): Promise<string> {
  await assertNotThrottled(groupIds);
  const hits = await findByPin(await membersOf(groupIds), pin);
  if (hits.length === 1) {
    await audit('login.pin_ok', { identityId: hits[0]!.identity_id });
    return hits[0]!.identity_id;
  }
  if (hits.length > 1) {
    // Cannot happen with set-time uniqueness; never guess if it does.
    await audit('login.pin_ambiguous', { data: { groupIds } });
    throw new HttpError(409, 'pin_ambiguous', 'PIN matches more than one member. Contact support.');
  }
  const left = await recordFailure(groupIds, 'pin');
  throw new HttpError(401, 'wrong_pin', 'Wrong PIN.', { attemptsLeft: left });
}

/**
 * No PIN yet, or forgot it: face (group) + that member's recovery code.
 * Sets a new PIN and replaces the recovery code (the old one is spent).
 */
export async function loginWithRecovery(
  groupIds: string[],
  code: string,
  newPin: string,
): Promise<{ identityId: string; recoveryCode: string }> {
  validatePin(newPin);
  await assertNotThrottled(groupIds);
  const normalized = code.trim().toUpperCase();
  let owner: Member | undefined;
  for (const m of await membersOf(groupIds)) {
    if (await verifySecret(normalized, m.recovery_code_hash)) owner = m;
  }
  if (!owner) {
    const left = await recordFailure(groupIds, 'recovery');
    throw new HttpError(401, 'wrong_code', 'Recovery code is wrong.', { attemptsLeft: left });
  }

  // If the new PIN clashes, nothing changes (old PIN and old code still valid).
  await setPin(owner.identity_id, newPin, { viaRecovery: true });

  const recoveryCode = newRecoveryCode();
  await pool.query('update credentials set recovery_code_hash = $2, failed_attempts = 0, locked_until = null where identity_id = $1', [
    owner.identity_id,
    await hashSecret(recoveryCode),
  ]);
  await audit('login.recovery_ok', { identityId: owner.identity_id, data: { recoveryCodeRotated: true } });
  return { identityId: owner.identity_id, recoveryCode };
}

export async function hasPin(identityId: string): Promise<boolean> {
  const r = await pool.query<{ has: boolean }>('select pin_hash is not null as has from credentials where identity_id = $1', [identityId]);
  return !!r.rows[0]?.has;
}
