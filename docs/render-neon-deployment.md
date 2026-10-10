# Render + Neon Deployment Runbook

How to take the OOU Attendance System from "repository prepared" to "serving
production traffic". This document describes the sequence; it does not perform
any of it.

> **Nothing in this runbook is automated.** Every step is a deliberate action by
> an operator. Do not batch these steps, and do not reorder steps 11 and 12.

## Architecture

```
Browser
  -> HTTPS
  -> Vercel            React/Vite frontend (static only, no Functions)
  -> /api/* rewrite    same-origin proxy
  -> Render            Node.js + Express API (Web Service)
  -> Neon              PostgreSQL
```

The browser only ever sees `https://oou-attendance-system.vercel.app`. It never
learns the Render hostname. Requests are same-origin, so there is no CORS
policy and the host-only session cookies keep working.

## What is already in the repository

| Area | State |
| --- | --- |
| Vercel builds | `npm run build --workspace frontend` |
| Vercel API routing | `/api/*` rewrites to a **placeholder** Render hostname in `vercel.json` |
| Vercel Functions | none — `api/index.js` has been deleted |
| Express build | `npm ci && npm run build --workspace backend` from the repository root |
| Express start | `npm start --workspace backend` -> `node dist/index.js` |
| Host / port | `HOST` and `PORT` read from the environment; `0.0.0.0` supported |
| Startup safety | no migration, reset or schema change on start; a configured sync provider emits its master-data feed seed exactly once at startup (migration 024 marker) |
| Health check | `/api/health` returns 200 with the database up, 503 with it down |
| Build dependencies | `.npmrc` sets `include=dev` so a production `NODE_ENV` cannot strip `tsc` and `@types/*` |
| Node version | `engines.node` pins Node 22 LTS in the root `package.json` |
| Trust proxy | **still `1`** — see step 11; do not change it before then |

## The four kinds of work

Keep these separate. Mixing them is how production databases get wiped.

| Kind | What it means | Steps |
| --- | --- | --- |
| **Repository configuration** | code and config in Git | already done |
| **Infrastructure provisioning** | creating Render and Neon resources | 1, 4 |
| **Database migration** | running `npm run migrate` against Neon | between 3 and 6 |
| **Deployment verification** | proving each piece works | 7-13 |

---

## 1. Provision Neon PostgreSQL

*Action: infrastructure provisioning.*

Create a Neon project and database.

Neon gives you more than one connection string. **You need both forms**, and
they are not interchangeable:

| Endpoint | Hostname looks like | Used for |
| --- | --- | --- |
| **Pooled** | `ep-xxx-pooler.<region>.aws.neon.tech` | the running Render service |
| **Direct** | `ep-xxx.<region>.aws.neon.tech` | migrations only |

The pooled endpoint sits behind PgBouncer and multiplexes many client
connections onto fewer real ones. That is what a long-running service wants, and
it is what keeps the connection count low on a small plan.

Do **not** use the direct endpoint for the web service. It is intended for
one-off administrative work.

## 2. Obtain the runtime pooled connection string

*Action: infrastructure provisioning.*

From Neon, copy the **pooled** connection string.

**Before using it, fix the `sslmode` parameter.** Neon hands out a string
ending in `sslmode=require`, and this application refuses that value at startup:

```
Refusing sslmode="require" in DATABASE_URL: this application requires the
server certificate and hostname to be verified.
```

This is deliberate. `pg` translates `sslmode=require` into
`ssl.rejectUnauthorized = false`, which silently accepts an unverified
connection. Change the parameter to `sslmode=verify-full`, or delete it entirely
and let the application apply its own TLS settings. Both are accepted.

Neon may also append `channel_binding=require`. Leave it if Neon documents it
for your plan; verify the first connection in step 8 before declaring success.

## 3. Obtain the direct connection string for migrations

*Action: infrastructure provisioning.*

Copy the **direct** (non-pooled) connection string and keep it somewhere
outside the repository. It is only needed when running migrations.

> **Warning: production migrations must use the direct Neon connection, and
> must never appear in the Render start command.** Migrations take schema locks
> and run DDL; behind a transaction pooler they can deadlock or leave a
> transaction half-applied. They must also never run automatically on every
> boot — concurrent instances booting at once would race each other.

## 4. Run migrations against Neon (manually)

*Action: database migration. Not part of deployment.*

Run this **once**, deliberately, from a workstation, before the service receives
any traffic:

```bash
# Set DATABASE_URL to the DIRECT (non-pooler) Neon connection string first.
npm run migrate --workspace backend
```

Notes:

- Migrations run through `tsx`, which is a dev dependency, so install
  dev dependencies in whatever environment you run this from. Do not use
  `npm ci --omit=dev` for a migration run.
- Take a Neon branch or snapshot first, so you have a rollback point.
- The running service must not be up yet, or at least must not be serving
  traffic, while the initial migration runs.

Do not add this command to the Render start command, a build command, or a
`predeploy` hook that could fire more than once.

## 5. Configure the Render Web Service

*Action: infrastructure provisioning.*

| Setting | Value |
| --- | --- |
| Root Directory | `/` |
| Build Command | `npm ci && npm run build --workspace backend` |
| Start Command | `npm start --workspace backend` |
| Health Check Path | `/api/health` |
| Instance type | 1 GB recommended (see [Excel import](#excel-import-and-memory)) |
| Node version | Node 22 LTS, from `engines.node` in the root `package.json` |

Root Directory must be the repository root. There is exactly one
`package-lock.json`, at the root, covering both workspaces. Setting the root to
`backend/` would break `npm ci` and lose the workspace layout.

Do not add a second lockfile, and do not introduce another package manager.

The build needs no extra system packages. `argon2` ships prebuilt Linux x64
binaries inside its own package and is loaded by `node-gyp-build`, which prefers
a matching prebuild over compiling from source.

### Node version

Node 22 LTS is pinned with `engines.node` in the root `package.json`, which is
the single declaration in this repository — there is deliberately no competing
`.nvmrc` or `.node-version`.

Why Node 22 rather than the default Render would otherwise pick:

- It matches the `@types/node` major already declared in the project
  (`^22.20.2`), so the runtime and the types agree.
- It satisfies every engine floor in the dependency tree. Vite 8 requires
  `^20.19.0 || >=22.12.0`, Playwright requires `>=20`, and Express, `pg`,
  `tsx`, TypeScript and `argon2` all have lower minimums.
- `argon2` is unaffected by the choice. Its prebuilds are N-API (version 8),
  which are ABI-stable across Node majors, so no recompilation is involved.

If a future upgrade moves `@types/node` and the Node pin together, change both.

### Build-time dependencies and `NODE_ENV=production`

The service must run with `NODE_ENV=production`, and Render sets it as an
environment variable. npm omits `devDependencies` whenever `NODE_ENV=production`
— and this repository builds TypeScript, so `typescript`, `tsx` and the
`@types/*` packages are all `devDependencies`.

If the build step inherits that variable, `npm ci` installs runtime packages
only, and the build fails with errors that name runtime packages rather than the
real cause:

```
TS7016: Could not find a declaration file for module 'express'
TS7016: Could not find a declaration file for module 'pg'
TS2591: Cannot find name 'process'
TS2503: Cannot find namespace 'NodeJS'
TS2584: Cannot find name 'console'
TS2304: Cannot find name 'URL'
```

Every one of those means "a type package is not installed". None of them is a
source defect, and no file needs editing to fix them.

The root `.npmrc` sets `include=dev`, so devDependencies install regardless of
`NODE_ENV`. That is already npm's default when `NODE_ENV` is unset, so local
development is unchanged. It is not a size or security regression: these
packages are build-time only, are never imported by the running server, and are
not reachable from any request.

The equivalent alternative is `npm ci --include=dev && npm run build --workspace
backend`. Prefer the `.npmrc`, because a build command typed into a dashboard
can be edited or re-entered incorrectly, whereas this cannot.

## 6. Configure Render environment variables

*Action: infrastructure provisioning.*

Set these in Render's dashboard. Never in Git, never in a commit message.

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | set explicitly; enables the production guards |
| `HOST` | `0.0.0.0` | **required**; the default `127.0.0.1` is unreachable from Render |
| `PORT` | Render-assigned | Render supplies it; leave it to Render |
| `DATABASE_URL` | Neon **pooled** string | with `sslmode=verify-full` or no `sslmode` |
| `WEBAUTHN_RP_ID` | `oou-attendance-system.vercel.app` | the Vercel host, **not** Render |
| `WEBAUTHN_ORIGIN` | `https://oou-attendance-system.vercel.app` | the Vercel origin |
| `WEBAUTHN_RP_NAME` | `OOU Attendance System` | optional; this is the built-in default |

#### Synchronization (this deployment is the provider)

The Render service is the sync **provider**: it serves the change feed to the
K12 edges and must never run the edge worker.

| Variable | Value | Notes |
| --- | --- | --- |
| `SYNC_PROVIDER_SECRET_HASH` | SHA-256 hex digest of the shared K12 edge secret | 64 lowercase hex characters; unset = the feed refuses every edge. Generate the secret/hash pair with the snippet in `docs/cloud-k12-sync.md` (Configuration). Never set the raw secret here. |
| `SYNC_PUBLISH_ON_STARTUP` | `true` (default) | Optional. Publish the cloud's current master data into the feed exactly once at startup (requires migration 024), marker-guarded against re-seeding. `false` disables it. |

**Do NOT set any of these on Render:** `SYNC_ENABLED`, `SYNC_CLOUD_BASE_URL`,
`SYNC_EDGE_ID`, `SYNC_EDGE_SECRET`. The cloud is the provider; the startup
guard fails the whole process if a provider also looks like it has the consumer
worker enabled.

Notes:

- The application refuses to start if `WEBAUTHN_RP_ID` or `WEBAUTHN_ORIGIN` is
  missing under `NODE_ENV=production`.
- Do **not** set `DATABASE_SSL=false`. It is rejected outright in production.
- Do **not** set `AUTH_COOKIE_SECURE=false`. Also rejected in production.
- The Render hostname must never appear in the WebAuthn variables. The browser
  runs the ceremony on the Vercel origin; a Render value fails verification.
- `DATABASE_POOL_MAX` defaults to `1` with a `DATABASE_URL`, which suits one
  instance. Raise it only deliberately.

## 7. Verify the health endpoint

*Action: deployment verification.*

```bash
curl -i https://<render-svc>.onrender.com/api/health
```

Expected when the database is reachable:

```
HTTP/1.1 200 OK
{"status":"ok","message":"OOU Attendance System API is running","database":"connected","timestamp":"..."}
```

`503` with `"database":"unavailable"` means the service is up but cannot reach
the database. Check `DATABASE_URL` and the `sslmode` value before anything
else. The endpoint never returns credentials or connection strings.

Render's own health check uses this same path, so a 503 marks the instance
unhealthy — which is the correct signal.

## 8. Verify database connectivity from the service

*Action: deployment verification.*

Confirm the startup log shows the connection-string source rather than the
discrete variables:

```
PostgreSQL pool initialised from connection-string configuration (max 1 per instance).
Database connection established.
```

`Database connection established.` comes from the read-only `SELECT 1` in
`backend/src/index.ts`. It proves the runtime path is safe: it opens a
connection, checks it, and logs. It does not migrate, seed, reset or modify
schema (the provider's exactly-once master-data publish is a separate startup
hook — see section 14 — and never runs as part of this check). A failure logs a
warning and the process keeps running with a degraded health endpoint, so a bad
database does not cause a crash loop.

Also confirm the Neon dashboard shows connections arriving, and that they are
arriving on the **pooled** endpoint.

## 9. Verify authentication and session cookies through the Vercel proxy

*Action: deployment verification.*

This is the step most likely to reveal a proxy problem, and it can only be
checked through the real proxy — hitting the Render hostname directly proves
nothing about cookies.

1. In `vercel.json`, the Render destination is still
   `render-service-placeholder.onrender.com`. Replace it with the real hostname
   **now** (see step 12 for why the ordering matters) and redeploy Vercel.
2. From a browser on `https://oou-attendance-system.vercel.app`, log in.
3. In DevTools -> Application -> Cookies, confirm `oou_session` is present,
   scoped to the Vercel host with no `Domain` attribute, `HttpOnly`, `Secure`
   and `SameSite=Lax`.
4. Confirm `/api/auth/me` returns your session through the proxy, not a 401.
5. Reload a deep link such as `/app/admin` to confirm the SPA fallback still
   serves `index.html`.

If the login succeeds directly against Render but fails through Vercel, the
rewrite is dropping or rewriting `Set-Cookie`. That is a proxy configuration
problem, not an application one — the cookie settings themselves are correct for
a single canonical origin.

## 10. Verify the WebAuthn configuration

*Action: deployment verification.*

- `GET /api/auth/student/device/options` should return options scoped to the
  Vercel origin.
- Enrol a device and then use it to log in, from the Vercel origin.
- Confirm `WEBAUTHN_RP_ID` is the Vercel host and not the Render host.

Do not add a preview-host or Render-host workaround if this fails. A WebAuthn
credential is bound to the origin the ceremony runs in, so the fix is always the
origin configuration, never a relaxation of verification.

## 11. Verify the real `X-Forwarded-For` behavior

*Action: deployment verification. Do this before touching the trust-proxy value.*

The repository still has `TRUSTED_PROXY_HOPS = 1` in
`backend/src/config/trustProxy.ts`, chosen when Vercel's edge was the only proxy
in front of Express. With Render in the path the chain is longer, so `1` is
probably wrong — but the correct value cannot be guessed, only observed.

Determine the real chain:

1. Send a request through the real Vercel rewrite so both proxies are involved.
2. Inspect the `X-Forwarded-For` header that actually reaches Express on Render.
   Inspect it in Render's request logs, or with a temporary log line that you
   remove afterwards. **Do not leave request logging in place permanently.**
3. Count the trustworthy intermediaries between the client and Express, set the
   constant to match, and update `trustProxy.ts`'s comment and
   `backend/tests/trustProxy.test.ts` together.

Do not set `trust proxy` to `true`. That trusts an arbitrary-length chain, so a
client could prepend a forged address and choose its own `req.ip`, defeating
IP-based rate limiting on the login endpoints.

For scale: this setting does not affect session cookies. `Secure` is derived from
`NODE_ENV`/`AUTH_COOKIE_SECURE`, and no code reads `req.protocol`, `req.secure` or
`req.hostname`.

## 12. Update `vercel.json` with the real Render hostname

*Action: repository configuration, then redeploy Vercel.*

Replace the placeholder:

```diff
-  "destination": "https://render-service-placeholder.onrender.com/api/:path*"
+  "destination": "https://<real-render-svc>.onrender.com/api/:path*"
```

Keep the `/api` prefix and the `:path*` wildcard. Dropping either breaks every
backend route.

`backend/tests/vercelEntryPoint.test.ts` asserts the *shape* of this
destination, not the hostname, so it stays green before and after the swap.

> Ordering matters: complete steps 9 and 11 **before** pointing Vercel at Render
> only if you want to inspect behaviour in isolation. In practice you will
> deploy the rewrite in step 9 and simply keep improving it afterwards. What you
> must not do is leave the placeholder in place and conclude that the deployment
> works.

## 13. Final end-to-end smoke tests

*Action: deployment verification.*

Against `https://oou-attendance-system.vercel.app`, through the proxy:

- [ ] Admin login, and the admin dashboard loads
- [ ] Lecturer login, course catalogue and a lecture session load
- [ ] Student login, registration and the student's device enrolment
- [ ] A student marks attendance; the lecturer sees it
- [ ] Attendance reporting returns real data
- [ ] The Excel student import completes, including the template download
- [ ] Passkey device login works end to end
- [ ] Logout clears `oou_session`
- [ ] A deep link such as `/app/admin` reloads correctly
- [ ] `/api/health` reports `database: connected`
- [ ] No credential or database detail appears in any response or log

---

## 14. Deploying a synchronization release (migrations 024/025)

This section covers the release that adds the provider's exactly-once master-data
publication (migration 024) and the outbound-claim lease (migration 025). Both
sides run the same migrations. The rule is the same as step 4: **database
migration before any new code starts**, then provider, then edges — never
combined.

### 14.1 Migrate both databases before any new backend boots

The new code refuses to run against the pre-025 schema. Every claim
(`claimPendingUploads`), the health aggregates, the stale-claim count and the
admin release reference `claimed_at`, `attempts` and the `IN_FLIGHT` status
added by migration 025; without that migration the column does not exist and the
status CHECK still rejects `IN_FLIGHT`. Migration 024 is additive (a new
singleton marker table).

1. **Provider database** — run migrations against the **direct** (non-pooled)
   Neon connection, from a workstation, exactly as in step 4. Never add this to
   the Render start command.
2. **Each edge / K12 PC** — run the same migrations against its own local
   database (`cd backend && npm run migrate`).

Verify **read-only** on both sides before deploying code:

```sql
SELECT filename FROM schema_migrations ORDER BY id;
```

The last two rows must be `024_sync_feed_publication_state.sql` and
`025_sync_outbound_claim.sql`.

### 14.2 Deploy the provider, then verify

Redeploy the backend to Render. On startup a configured provider publishes its
current master data into the feed exactly once (migration 024 marker); the logs
show `Published N master-data feed events...` or `Sync feed already seeded;...`.
Confirm with the admin snapshot: `GET /api/admin/sync-status` →
`"role": "PROVIDER"` and `"publication": { "seeded": true, ... }`.

### 14.3 Deploy the edges, then verify

For each PC: pull the new code, apply the PC's local migrations (14.1), restart.
Confirm `GET /api/admin/sync-status` reports `"role": "EDGE"`,
`"staleInFlight": 0` and sensible outbound counts; mark one attendance row and
watch it move `PENDING` → `IN_FLIGHT` → `SENT` (a refused mark parks as
`REJECTED` for the admin requeue action).

### 14.4 Rollback

A sync rollback is **code only** — the schema stays on migration 025.

- Provider: revert the commit and redeploy. Migrations 024/025 are additive and
  forward-compatible; the older code never reads the new columns and never
  writes `IN_FLIGHT`, so it runs unchanged against the 025 schema.
- Edge: **before** reverting to pre-claim code, return every `IN_FLIGHT` row to
  `PENDING`. Either let the running code's lease reclaim them (automatic once
  `claimed_at` is older than the claim timeout) or call
  `POST /api/admin/sync-outbound/release-stale-claims`. Pre-claim code selects
  only `status = 'PENDING'`, so a claimed row would be invisible to it.

There is no down-migration for 025, and dropping its columns to "roll back" is
never correct. If a database rollback is ever genuinely required, restore the
Neon branch/snapshot from step 4 — attendance data is at stake, so ask first.

### 14.5 Tooling that is not routine recovery

`backend/scripts/rebuildCloudSyncFeed.ts` truncates the change feed and restarts
its identity sequence; `backend/scripts/resetEdgeCheckpoint.sql` deletes a
consumer's processed-event receipts and zeros its cursor. Both renumber or rewind
the feed and silently break the cursor and idempotency guarantees. They exist
for reconstruction after a data restore, are not part of deployment, recovery or
rollback, and **must not be run for those purposes**. Missing feed events are
repaired append-only with `backend/scripts/backfillMasterDataFeed.ts` (see
`docs/cloud-k12-sync.md`).

---

## Security rules

- Never commit a production secret: no `DATABASE_URL`, database password, Render
  API token or Neon credential enters Git, a commit message, or a log.
- Real production values live in Render's encrypted environment settings, and
  locally in `backend/.env`, which is ignored by Git.
- Never set `DATABASE_SSL=false` or `AUTH_COOKIE_SECURE=false` in production.
  Both are rejected outright when `NODE_ENV=production`.
- Never set `SYNC_ENABLED`, `SYNC_CLOUD_BASE_URL`, `SYNC_EDGE_ID` or
  `SYNC_EDGE_SECRET` on Render (the provider must not run the edge worker), and
  never set `SYNC_PROVIDER_SECRET_HASH` on an edge PC.
- Never run `backend/scripts/rebuildCloudSyncFeed.ts` or
  `backend/scripts/resetEdgeCheckpoint.sql` as deployment or recovery: they
  truncate the change feed / delete receipts and reset cursors, which silently
  breaks the cursor and idempotency guarantees. Repair missing feed events only
  with the append-only `backend/scripts/backfillMasterDataFeed.ts`.
- Never run `npm run seed:e2e`, `npm run unseed:e2e` or
  `npm run test:db:prepare` against production. Those exist only for the local
  and E2E test database.
- Never put migrations in the Render start command.
- Do not add a debug or test endpoint to make a health check pass.
- Do not enable CORS to make the proxy work. Requests are same-origin by design.
- Do not weaken WebAuthn verification or relax session cookie attributes to make
  a deployment succeed.

## Rollback

- Application: revert the commit and redeploy. Render and Neon are unchanged.
- Vercel routing: restore the previous `vercel.json` and redeploy.
- Database: do **not** assume a down migration exists. Restore a Neon branch or
  snapshot taken before step 4, and treat attendance data as important — ask
  before discarding anything.
- Synchronization (migrations 024/025): a sync rollback is code-only — the
  database stays on migration 025 (see step 14). Before reverting an edge to
  the pre-claim code, return any `IN_FLIGHT` queue rows to `PENDING` (the lease
  reclaims them once the running code drains, or
  `POST /api/admin/sync-outbound/release-stale-claims` releases them).

## Excel import and memory

The 10 MB upload limit, `multer` memory storage and ExcelJS parsing are
unchanged, and all three work normally on a Render Web Service. There is no
platform request-size cap comparable to the old Vercel Function limit, so the
limit was neither raised nor lowered.

What did change is where the memory is spent. The file is buffered in memory and
then expanded into workbook objects, so peak usage is a multiple of the 10 MB
file size. A small instance can be pushed close to its limit by one large
import. Start with 1 GB, and treat a sustained pattern of large imports as a
reason to raise the instance size rather than to lower the limit.

## Related documents

- [`docs/lan-mode.md`](lan-mode.md) — local network access, unchanged by this
  deployment
- [`docs/lan-https-webauthn.md`](lan-https-webauthn.md) — why passkeys need a
  trusted HTTPS origin on a LAN
- `backend/.env.example` — the production variable reference
