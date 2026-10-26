import { DescribeCollectionCommand } from '@aws-sdk/client-rekognition';
import cors from 'cors';
import express from 'express';
import { rekognition } from './aws.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { errorHandler } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { claimsRouter } from './routes/claims.js';
import { expireDueClaims } from './services/claims.js';

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '10mb' })); // joint-capture frames arrive as base64

/** Postgres reachable, migrations applied, Rekognition collection reachable. */
app.get('/health', async (_req, res) => {
  const db = await pool
    .query<{ tables: number }>(
      `select count(*)::int as tables from information_schema.tables where table_schema = 'public'`,
    )
    .then((r) => ({ ok: true, tables: r.rows[0]?.tables }))
    .catch((e: Error) => ({ ok: false, error: e.message }));

  const collection = await rekognition
    .send(new DescribeCollectionCommand({ CollectionId: config.collectionId }))
    .then((r) => ({ ok: true, id: config.collectionId, faces: r.FaceCount, model: r.FaceModelVersion }))
    .catch((e: Error) => ({ ok: false, id: config.collectionId, error: e.message }));

  const ok = db.ok && collection.ok;
  res.status(ok ? 200 : 503).json({ ok, region: config.region, db, collection });
});

// Config the React client needs to start a liveness stream.
app.get('/config', (_req, res) => {
  res.json({ region: config.region, identityPoolId: config.identityPoolId });
});

app.use(authRouter);
app.use(claimsRouter);
app.use(errorHandler);

const applied = await migrate();
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

// Expiry sweeper: abandoned claims never lock anyone out.
setInterval(() => {
  expireDueClaims()
    .then((n) => n && console.log(`expired ${n} claim(s)`))
    .catch((e) => console.error('sweeper failed', e));
}, 60_000);

app.listen(config.port, () => {
  console.log(`twin-resolver server on http://localhost:${config.port}`);
  console.log(`face match threshold ${config.faceMatchThreshold}, liveness min ${config.livenessMinConfidence}`);
});
