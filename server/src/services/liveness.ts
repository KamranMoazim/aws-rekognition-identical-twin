import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
} from '@aws-sdk/client-rekognition';
import { rekognition } from '../aws.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../lib/http.js';

export type LivenessPurpose = 'register' | 'login' | 'claim' | 'recovery';

/** Backend creates the session; the browser only streams video into it. */
export async function createLivenessSession(
  purpose: LivenessPurpose,
  claim?: { claimId: string; role: 'owner' | 'claimant' },
): Promise<string> {
  const out = await rekognition.send(
    new CreateFaceLivenessSessionCommand({ Settings: { AuditImagesLimit: 0 } }),
  );
  const sessionId = out.SessionId!;
  await pool.query(
    'insert into liveness_sessions (session_id, purpose, claim_id, role) values ($1, $2, $3, $4)',
    [sessionId, purpose, claim?.claimId ?? null, claim?.role ?? null],
  );
  return sessionId;
}

/**
 * Spend a liveness session exactly once and return its reference image.
 * The session is marked used BEFORE reading results, so a replay or a
 * parallel request can never use the same session twice.
 */
export async function consumeLiveness(
  sessionId: string,
  purpose: LivenessPurpose,
): Promise<{ bytes: Uint8Array; confidence: number }> {
  const spent = await pool.query(
    `update liveness_sessions set used = true
      where session_id = $1 and purpose = $2 and used = false
        and created_at > now() - interval '10 minutes'
      returning session_id`,
    [sessionId, purpose],
  );
  if (!spent.rowCount) {
    throw new HttpError(400, 'liveness_invalid', 'Liveness session unknown, expired, already used, or for another purpose');
  }

  const result = await rekognition.send(new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }));
  const confidence = result.Confidence ?? 0;
  await pool.query('update liveness_sessions set confidence = $2 where session_id = $1', [sessionId, confidence]);

  if (result.Status !== 'SUCCEEDED') {
    throw new HttpError(400, 'liveness_incomplete', `Liveness session status is ${result.Status}`);
  }
  if (confidence < config.livenessMinConfidence) {
    throw new HttpError(403, 'liveness_failed', 'Liveness check did not pass', { confidence });
  }
  const bytes = result.ReferenceImage?.Bytes;
  if (!bytes) throw new HttpError(502, 'no_reference_image', 'Liveness returned no reference image');
  return { bytes, confidence };
}
