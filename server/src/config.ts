import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

// .env is optional; real env vars win.
const envFile = path.join(serverRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

type CdkOutputs = { TwinResolverStack?: Record<string, string> };

function readCdkOutputs(): Record<string, string> {
  const file = path.resolve(serverRoot, '../infra/cdk-outputs.json');
  if (!existsSync(file)) return {};
  const json = JSON.parse(readFileSync(file, 'utf8')) as CdkOutputs;
  return json.TwinResolverStack ?? {};
}

const cdk = readCdkOutputs();

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}. Deploy infra (npm run infra:deploy) or set it in server/.env`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://twin:twin@localhost:5434/twin',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  region: required('AWS_REGION / Region output', process.env.AWS_REGION ?? cdk.Region),
  collectionId: required('COLLECTION_ID / CollectionId output', process.env.COLLECTION_ID ?? cdk.CollectionId),
  identityPoolId: cdk.IdentityPoolId ?? process.env.IDENTITY_POOL_ID ?? '',
  faceMatchThreshold: Number(process.env.FACE_MATCH_THRESHOLD ?? 90),
  livenessMinConfidence: Number(process.env.LIVENESS_MIN_CONFIDENCE ?? 90),
  // Signs session and match tokens. Random per process if unset (tokens die on restart).
  tokenSecret: process.env.TOKEN_SECRET || randomBytes(32).toString('hex'),
  // Shared secret for the review queue (X-Admin-Token). Unset = admin endpoints disabled.
  adminToken: process.env.ADMIN_TOKEN ?? '',
  migrationsDir: path.join(serverRoot, 'migrations'),
};
