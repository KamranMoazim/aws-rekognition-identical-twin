# Twin Collision Resolver

Learning build: give two lookalikes (identical twins) separate identities on AWS Rekognition,
without letting one person create two identities. Full design: "Twin Collision Resolver - Build Plan" doc.

Core idea: faces cannot prove two people exist, but two live faces in the same frame can.

## Layout

| Folder | What |
| --- | --- |
| `infra/` | CDK stack: Rekognition collection + Cognito identity pool (browser liveness). `cdk destroy` removes all of it. |
| `server/` | Express + TypeScript API, Postgres, runs locally with your AWS profile |
| `client/` | Vite + React, Amplify `FaceLivenessDetector` for the camera check |
| `docker-compose.yml` | Postgres 16 on port 5434 |

## Build steps

| Step | What | Status |
| --- | --- | --- |
| 1 | Infra, Postgres, server skeleton, full schema, `/health` | done |
| 2 | Register + login with Face Liveness, React client | done |
| 3 | Claims: state machine, expiry, owner confirm | next |
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

## Run (step 2)

```bash
npm --prefix client install
npm run server:dev           # terminal 1 (:4000)
npm run client:dev           # terminal 2 (:5173, proxies /api to :4000)
```

Open http://localhost:5173, then:

1. Register with your name. The liveness check runs; you get an identity and a one-time recovery code.
2. Sign out, then "Log in with face": you land in the same identity.
3. Sign out, then try to Register again: you get "This face is already registered". No second identity is created.

### API (step 2)

| Method | Path | Does |
| --- | --- | --- |
| POST | /liveness/sessions | `{purpose: "register" or "login"}` -> `{sessionId}` |
| POST | /register | `{sessionId, displayName}` -> 201 identity + recovery code, or 409 match + `matchToken` |
| POST | /login | `{sessionId}` -> session token, 404 no match, 409 if the face matches a group or several identities |
| GET | /me | Bearer session token -> identity |

## Tear down

```bash
npm run infra:destroy        # deletes collection (and all indexed faces) + identity pool + role
npm run db:reset             # or: docker compose down -v
```
