import {
  DeleteFacesCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  SearchFacesCommand,
  type FaceMatch,
} from '@aws-sdk/client-rekognition';
import { rekognition } from '../aws.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../lib/http.js';

export type IdentityMatch = { identityId: string; similarity: number };

/** Map Rekognition face matches to OUR identities (faces table is the source of truth). */
async function toIdentityMatches(matches: FaceMatch[]): Promise<IdentityMatch[]> {
  const faceIds = matches.map((m) => m.Face?.FaceId).filter((id): id is string => !!id);
  if (!faceIds.length) return [];
  const rows = await pool.query<{ rekognition_face_id: string; identity_id: string }>(
    'select rekognition_face_id, identity_id from faces where rekognition_face_id = any($1)',
    [faceIds],
  );
  const owner = new Map(rows.rows.map((r) => [r.rekognition_face_id, r.identity_id]));
  const best = new Map<string, number>();
  for (const m of matches) {
    const identityId = owner.get(m.Face?.FaceId ?? '');
    if (!identityId) continue; // orphan face in the collection: ignore
    best.set(identityId, Math.max(best.get(identityId) ?? 0, m.Similarity ?? 0));
  }
  return [...best]
    .map(([identityId, similarity]) => ({ identityId, similarity }))
    .sort((a, b) => b.similarity - a.similarity);
}

/** Who does this face look like? Empty array = nobody above the threshold. */
export async function searchByImage(bytes: Uint8Array): Promise<IdentityMatch[]> {
  try {
    const out = await rekognition.send(
      new SearchFacesByImageCommand({
        CollectionId: config.collectionId,
        Image: { Bytes: bytes },
        FaceMatchThreshold: config.faceMatchThreshold,
        MaxFaces: 10,
      }),
    );
    return toIdentityMatches(out.FaceMatches ?? []);
  } catch (err) {
    if ((err as Error).name === 'InvalidParameterException') {
      throw new HttpError(422, 'no_face', 'No face found in the image');
    }
    throw err;
  }
}

/** Who else looks like an already-indexed face? (excludes the face itself) */
export async function searchByFaceId(faceId: string): Promise<IdentityMatch[]> {
  const out = await rekognition.send(
    new SearchFacesCommand({
      CollectionId: config.collectionId,
      FaceId: faceId,
      FaceMatchThreshold: config.faceMatchThreshold,
      MaxFaces: 10,
    }),
  );
  return toIdentityMatches(out.FaceMatches ?? []);
}

export async function indexFace(bytes: Uint8Array, identityId: string): Promise<string> {
  const out = await rekognition.send(
    new IndexFacesCommand({
      CollectionId: config.collectionId,
      Image: { Bytes: bytes },
      ExternalImageId: identityId,
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    }),
  );
  const faceId = out.FaceRecords?.[0]?.Face?.FaceId;
  if (!faceId) throw new HttpError(422, 'face_quality', 'Face could not be indexed (quality too low)');
  return faceId;
}

export async function deleteFaces(faceIds: string[]): Promise<void> {
  if (!faceIds.length) return;
  await rekognition.send(new DeleteFacesCommand({ CollectionId: config.collectionId, FaceIds: faceIds }));
}
