import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import type { IdentityMatch } from './faces.js';
import { groupsOf } from './identities.js';
import { pool } from '../db.js';

export type LoginDecision = { kind: 'identity'; identityId: string } | { kind: 'pin_required'; groupIds: string[] };

/**
 * What a face match allows (no AWS here: unit-testable).
 *  - one identity, not in a group      -> logged in by face
 *  - identities that are all in groups -> PIN picks the member
 *  - anything else ambiguous           -> refused, never guessed
 */
export async function decideLogin(matches: IdentityMatch[], confidence?: number): Promise<LoginDecision> {
  if (!matches.length) {
    await audit('login.no_match', { data: { confidence } });
    throw new HttpError(404, 'no_match', 'No identity matches this face. Register first.');
  }
  const ids = matches.map((m) => m.identityId);
  const groupIds = await groupsOf(ids);

  if (groupIds.length) {
    // Every matched identity must belong to one of those groups; a stray ungrouped match is a red flag.
    const grouped = await pool.query<{ identity_id: string }>(
      'select identity_id from group_members where identity_id = any($1)',
      [ids],
    );
    if (grouped.rowCount !== ids.length) {
      await audit('login.ambiguous', { data: { matches, groupIds } });
      throw new HttpError(409, 'ambiguous_match', 'This face matches identities outside its group. Login refused.');
    }
    await audit('login.group_match', { data: { matches, groupIds } });
    return { kind: 'pin_required', groupIds };
  }

  if (ids.length > 1) {
    // Two separate identities match and they never proved they are different people: never guess.
    await audit('login.ambiguous', { data: { matches } });
    throw new HttpError(409, 'ambiguous_match', 'This face matches more than one identity. Login refused.');
  }
  await audit('login.ok', { identityId: ids[0], data: { similarity: matches[0]!.similarity, confidence } });
  return { kind: 'identity', identityId: ids[0]! };
}
