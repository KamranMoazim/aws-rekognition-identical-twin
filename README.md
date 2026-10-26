# Twin Collision Resolver

Learning build: give two lookalikes (identical twins) separate identities on AWS Rekognition,
without letting one person create two identities. Full design: "Twin Collision Resolver - Build Plan" doc.

Core idea: faces cannot prove two people exist, but two live faces in the same frame can.

## Layout

| Folder | What |
| --- | --- |
| `infra/` | CDK stack: Rekognition collection + Cognito identity pool (browser liveness). `cdk destroy` removes all of it. |
| `server/` | Express + TypeScript API, Postgres, runs locally with your AWS profile |
| `client/` | Simple React app (added in step 2) |
| `docker-compose.yml` | Postgres 16 on port 5434 |

## Build steps

| Step | What | Status |
| --- | --- | --- |
| 1 | Infra, Postgres, server skeleton, full schema, `/health` | done |
| 2 | Register + login with Face Liveness, React client | next |
| 3 | Claims: state machine, expiry, owner confirm | |
| 4 | Co-presence check: challenge, joint capture, pass rules | |
| 5 | Collision groups + PIN login | |
| 6 | Hardening: recovery, throttles, races, review queue | |

## Run (step 1)

```bash
npm run install:all          # installs infra/ and server/
npm run db:up                # postgres:16 on localhost:5434
npm run infra:deploy         # CDK -> us-east-1, writes infra/cdk-outputs.json
cp server/.env.example server/.env   # set AWS_PROFILE if not "default"
npm run server:dev           # migrates, then listens on :4000
curl localhost:4000/health
```

Expected: `{"ok":true, ... "db":{"ok":true,"tables":10}, "collection":{"ok":true,"faces":0,...}}`

First CDK deploy in this account/region needs `npx cdk bootstrap` (run inside `infra/`).

## Tear down

```bash
npm run infra:destroy        # deletes collection (and all indexed faces) + identity pool + role
npm run db:reset             # or: docker compose down -v
```
