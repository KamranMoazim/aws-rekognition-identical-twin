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
| 3 | Claims: state machine, expiry, owner confirm | done |
| 4 | Co-presence check: challenge, joint capture, pass rules | done |
| 5 | PIN set + PIN login for collision groups | done |
| 6 | Hardening: third lookalike, repeat-claim limits, cross-device resume, review queue | next |

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

## Run (step 3)

```bash
npm run server:dev                      # applies migration 002 on start
npm --prefix server run test:claims     # 19 checks, uses its own twin_test database
```

Manual flow (needs two people, or force a match with a low threshold, e.g. `FACE_MATCH_THRESHOLD=60` in `server/.env`):

1. Person A registers (keeps the recovery code).
2. Person B registers, gets "This face is already registered", clicks "This is not me, open a claim". B's page now shows the claim and updates itself.
3. A logs in by face, sees "Someone says they are not you", enters the recovery code, clicks Confirm. B's page moves to "Owner confirmed".

Also try: wrong code (tries left), 5 wrong codes (locked 15 min), "I do not know them" (manual review), Cancel claim.

Why the recovery code: B's face can log in to A's account (that is the whole problem), so face login cannot prove the owner is taking part. The code can.

### API (step 3)

| Method | Path | Auth | Does |
| --- | --- | --- | --- |
| POST | /claims | `matchToken` from a 409 register | Opens a claim, returns `claimToken` |
| GET | /claims/:id | `X-Claim-Token` or owner session | State + next step |
| DELETE | /claims/:id | `X-Claim-Token` | Claimant cancels |
| GET | /me/claims | owner session | Active claims against me |
| POST | /claims/:id/owner-confirm | owner session + `recoveryCode` | open -> owner_confirmed |
| POST | /claims/:id/owner-decline | owner session | open -> review |

Claims expire 24 h after opening (sweeper every minute, plus a check on every read). One active claim per identity (partial unique index). Every state change locks the claim row, so two racing requests cannot both succeed.

## Run (step 4)

```bash
npm --prefix server install             # adds sharp (crops faces out of the joint photo)
npm run server:dev                      # applies migration 003
npm --prefix server test                # rules (19) + claims (21) + co-presence (22), no AWS calls
```

After the owner confirms (step 3), the claimant's page shows the co-presence check. Everything happens on that one device:

1. **Liveness, one person at a time.** The owner, then the claimant, each pass Face Liveness (AWS fails a session with two faces, so it cannot be done together). Each live face must match the owner's identity. Valid for 10 minutes.
2. **Joint check.** "Start joint check" gets a random challenge: which side the claimant stands on, and a different head movement per side (turn / tilt / nod). 8-second countdown, then one photo.
3. **Server rules on that photo:** exactly 2 faces (confidence 90+), each at least 8% of frame width, sizes within 2x of each other, each face cropped and searched alone must match the owner and nobody else, each must hold its own pose.
4. **Pass:** the claimant gets an identity (face indexed from the joint photo, source `co_presence`) and a recovery code; owner + claimant become one collision group. **Fail:** reasons and measured angles shown; after 3 failures the claim goes to manual review.

Alone you should FAIL (1 face). You + a photo of yourself should FAIL (the photo cannot follow its pose). The PASS path is covered by `test/copresence.test.ts` with a scripted Rekognition; for a real pass you need a second person whose face matches yours at your `FACE_MATCH_THRESHOLD`.

Note: after a pass, both people's face logins return `pin_required` until step 5 adds PINs.

### API (step 4) — all with `X-Claim-Token`

| Method | Path | Does |
| --- | --- | --- |
| GET | /claims/:id/liveness | `{owner, claimant}` passed in the last 10 min |
| POST | /claims/:id/liveness-session | `{role}` -> liveness session bound to claim + role |
| POST | /claims/:id/liveness | `{role, sessionId}` -> spend it; both passed moves claim to both_live |
| POST | /claims/:id/challenge | Random sides + poses, valid 60 s, single use |
| POST | /claims/:id/joint-capture | `{image: base64 jpeg}` -> pass (identity, recovery code, session) or fail (reasons, angles, attempts left) |

## Run (step 5)

```bash
npm run server:dev                      # applies migration 004
npm --prefix server test                # rules 19 + claims 21 + co-presence 22 + pins 35
```

How login works now:

| Face matches | Result |
| --- | --- |
| one identity, not in a group | logged in by face (as before) |
| a collision group member | `pin_required` + 5-minute PIN token; PIN picks the member |
| several unrelated identities, or a group plus a stray identity | refused (`ambiguous_match`), never guessed |

- **First PIN:** the claimant is signed in after the co-presence pass and sees "Set your PIN now". The owner logs in by face, gets the PIN step, and uses "No PIN yet / forgot it" with their recovery code.
- **Forgot PIN:** face + recovery code + new PIN. The recovery code is then replaced (shown once). A face alone never resets a PIN.
- **Uniqueness:** members of one group cannot share a PIN (checked at set time with the group row locked; parallel identical PINs: exactly one wins). Weak PINs (repeated or sequential digits) are refused.
- **Throttle, not lockout:** 5 wrong PINs or recovery codes for a group in 15 minutes pause that group's PIN logins. No member's account is ever locked by someone else's guesses.

### API (step 5)

| Method | Path | Does |
| --- | --- | --- |
| POST | /login | now returns `{status: "pin_required", pinToken}` for group members |
| POST | /login/pin | `{pinToken, pin}` -> session |
| POST | /login/recovery | `{pinToken, recoveryCode, newPin}` -> session + new recovery code |
| GET | /me | adds `hasPin`, `needsPin` |
| POST | /me/pin | `{pin, currentPin?}` set or change |

## Tear down

```bash
npm run infra:destroy        # deletes collection (and all indexed faces) + identity pool + role
npm run db:reset             # or: docker compose down -v
```
