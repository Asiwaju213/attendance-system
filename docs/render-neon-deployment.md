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
| Startup safety | no migration, seed, reset or schema change on start |
| Health check | `/api/health` returns 200 with the database up, 503 with it down |
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

Root Directory must be the repository root. There is exactly one
`package-lock.json`, at the root, covering both workspaces. Setting the root to
`backend/` would break `npm ci` and lose the workspace layout.

Do not add a second lockfile, and do not introduce another package manager.

The build needs no extra system packages. `argon2` ships prebuilt Linux x64
binaries inside its own package and is loaded by `node-gyp-build`, which prefers
a matching prebuild over compiling from source.

> **Open item:** the repository declares **no Node version** (no `engines`
> field, no `.nvmrc`). Render will pick its own default, which can change over
> time. Once the deployment is proven, pin the working version — either as an
> `engines` field in the root `package.json` or as Render's `NODE_VERSION`
> setting. Do this as a separate, deliberate change, after a successful deploy.

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
schema. A failure logs a warning and the process keeps running with a degraded
health endpoint, so a bad database does not cause a crash loop.

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

## Security rules

- Never commit a production secret: no `DATABASE_URL`, database password, Render
  API token or Neon credential enters Git, a commit message, or a log.
- Real production values live in Render's encrypted environment settings, and
  locally in `backend/.env`, which is ignored by Git.
- Never set `DATABASE_SSL=false` or `AUTH_COOKIE_SECURE=false` in production.
  Both are rejected outright when `NODE_ENV=production`.
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
