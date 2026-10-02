# OOU Attendance System

A production-minded university attendance management system for Olabisi Onabanjo University (OOU). This system will manage student attendance tracking, lecturer workflows, course management, and administrative reporting.

## Technology Stack

| Layer       | Technology                          |
| ----------- | ----------------------------------- |
| Frontend    | React + TypeScript (Vite)           |
| Backend     | Node.js + Express.js + TypeScript   |
| Database    | PostgreSQL                          |
| API Style   | REST                                |
| Testing     | Playwright                          |
| Package Mgr | npm                                 |

## Project Structure

```
attendance-system/
├── frontend/          # React + TypeScript client application
├── backend/           # Express.js + TypeScript API server
├── database/          # Database schemas and migrations (coming soon)
├── docs/              # Project documentation (see docs/lan-mode.md and
│                      #   docs/cloud-k12-sync.md)
├── tests/e2e/         # Playwright end-to-end browser tests
├── playwright.config.ts
├── package.json       # Root package.json (E2E test scripts)
└── README.md
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- npm (comes with Node.js)
- [PostgreSQL](https://www.postgresql.org/download/) running locally

### Installation

Clone the repository and install dependencies for the root (Playwright), frontend, and backend:

```bash
# Clone the repository
git clone <repository-url>
cd attendance-system

# Install root dependencies (Playwright)
npm install

# Install frontend dependencies
cd frontend
npm install

# Install backend dependencies
cd ../backend
npm install
```

### Running the Frontend

```bash
cd frontend
npm run dev
```

The frontend will start on `http://localhost:4173` by default. The port is pinned in `frontend/vite.config.ts` so it never changes silently.

### Running the Backend

```bash
cd backend
npm run dev
```

The backend will start on `http://localhost:5000`. It uses `tsx watch` to automatically restart when source files change. The backend loads its PostgreSQL credentials from the `.env` file in the `backend/` directory. The interface it listens on is configurable with the optional `HOST` and `PORT` variables (see [Running on the local network](#running-on-the-local-network-lan-mode)).

### Running on the local network (LAN mode)

To let a phone on the local router's Wi-Fi load the app, set the server host to a network interface in each project's `.env`:

```ini
# backend/.env
HOST=0.0.0.0
PORT=5000
```

```ini
# frontend/.env (copy .env.example first)
VITE_DEV_HOST=0.0.0.0
VITE_DEV_PORT=4173
VITE_API_PROXY_TARGET=http://127.0.0.1:5000
```

The device then opens `http://<the PC's LAN address>:<VITE_DEV_PORT>`. The browser always requests the relative path `/api/...`, which the Vite dev server proxies to the backend, so requests stay same-origin — no CORS policy is involved and the HTTP-only session cookies keep working. Read the LAN address from the machine (`ipconfig`); it is never hard-coded in application source.

Both settings default to loopback (`127.0.0.1`), so normal local development and cloud deployment are unaffected.

> **LAN mode only makes the application listen on the local network. It does not configure Windows routing, Internet Connection Sharing, NAT, or firewall rules.**

Student passkey features (device enrollment, passkey login, attendance device verification) do **not** work from a plain-HTTP LAN address. Three independent browser rules each block it: WebAuthn needs a secure context, the RP ID must be a real registrable domain (not an IP address and not a `.local` name), and Chrome has refused WebAuthn on untrusted certificates since Chrome 110. Every other flow works from a phone, because it authenticates with the session cookie.

See [`docs/lan-mode.md`](docs/lan-mode.md) for the traffic paths, the configuration switches, and the manual network-side steps. See [`docs/lan-https-webauthn.md`](docs/lan-https-webauthn.md) for the passkey investigation: what a trusted HTTPS LAN origin would require (a real hostname, a public certificate obtainable via `DNS-01` without a public IP, and split-horizon DNS), why the usual workarounds fail, and the `AUTH_COOKIE_SECURE` switch.


### PostgreSQL Database Setup

1. Make sure PostgreSQL is installed and running on your machine.
2. Create the database (only once):

   ```bash
   createdb oou_attendance
   ```

   or, if you prefer the psql shell:

   ```psql
   CREATE DATABASE oou_attendance;
   ```

3. Configure the backend connection. Copy the example environment file and fill in your own PostgreSQL credentials (do not commit `.env` — it is ignored by Git):

   ```bash
   cd backend
   copy .env.example .env
   ```

   Then open `.env` and set your local values:

   ```
   DATABASE_HOST=localhost
   DATABASE_PORT=5432
   DATABASE_NAME=oou_attendance
   DATABASE_USER=your_database_user
   DATABASE_PASSWORD=your_database_password
   ```

   These five variables are all that local development needs. A connection can
   instead be given as a single `DATABASE_URL` (used for a pooled, TLS cloud
   database, and ignored whenever the five variables above are in use without
   it). See `backend/.env.example` for the cloud form, the TLS rules and the
   optional connection-pool settings.

4. Start the backend and watch the startup log. A successful connection prints:

   ```
   Database connection established.
   ```

No tables are created yet. Schema and migrations will be added in a later step.

### Health Check

Once the backend is running, verify it is healthy and can reach PostgreSQL:

```
GET http://localhost:5000/api/health
```

Expected response when the database is reachable:

```json
{
  "status": "ok",
  "message": "OOU Attendance System API is running",
  "database": "connected",
  "timestamp": "2026-09-10T..."
}
```

If the database is unreachable, the endpoint returns HTTP 503 with `"database": "unavailable"` and `"status": "degraded"`.

## Cloud ↔ K12 Edge Synchronization

See [`docs/cloud-k12-sync.md`](docs/cloud-k12-sync.md) for the cloud ↔ K12 edge
synchronization design: authoritative data ownership, cursor/event ordering,
idempotency, edge authentication, the worker's lifecycle, failure behavior, and
the `SYNC_*` configuration.

## End-to-End Testing with Playwright

Playwright drives a real browser against the running frontend application. Tests live in `tests/e2e/` and are configured by `playwright.config.ts` at the project root. The config automatically starts the Vite dev server (in `frontend/`) before the tests run, so you do not need to start it manually.

### Installing Playwright browsers (first time only)

```bash
cd attendance-system
npx playwright install chromium
```

This downloads the Chromium browser used by the tests. Windows users run the same command (no extra system dependencies are needed).

### Running the tests

```bash
npm run test:e2e
```

This runs all specs in `tests/e2e/` against Chromium in headless mode.

### Running tests in headed mode

```bash
npm run test:e2e:headed
```

A visible Chromium window opens so you can watch the test steps live. Useful for debugging.

### Viewing the HTML report

```bash
npm run test:e2e:report
```

After a run, Playwright saves an interactive HTML report to `playwright-report/`. The command above opens it in your browser. Traces, screenshots, and videos on failures are saved under `test-results/`. Both folders are ignored by Git.

## Production Deployment

### Architecture

```
Browser
  -> HTTPS
  -> Vercel            React/Vite frontend (static only, no Functions)
  -> /api/* rewrite    same-origin proxy
  -> Render            Node.js + Express API (Web Service)
  -> Neon              PostgreSQL
```

The browser only ever sees `https://oou-attendance-system.vercel.app`. It never
learns the Render hostname: the frontend keeps requesting relative `/api/...`
paths, Vercel proxies them, and the request stays same-origin. That is why there
is no CORS policy and why the host-only session cookies keep working.

Vercel builds and serves the frontend only. The Express API runs on Render as a
long-running Node process, and PostgreSQL is provided by Neon.

### Render

Set these in the Render dashboard. **Root Directory must be `/`** (the
repository root): there is exactly one `package-lock.json`, at the root,
covering both npm workspaces. Pointing the root at `backend/` would break
`npm ci` and lose the workspace layout.

| Setting | Value |
| --- | --- |
| Root Directory | `/` |
| Build Command | `npm ci && npm run build --workspace backend` |
| Start Command | `npm start --workspace backend` (runs `node dist/index.js`) |
| Health Check Path | `/api/health` |
| Host | `0.0.0.0` |
| Port | Render-provided `PORT` |
| Node version | Node 22 LTS, from `engines.node` in the root `package.json` |

`HOST` must be `0.0.0.0` on Render. The application otherwise defaults to
`127.0.0.1`, which is unreachable from outside the machine, so a service left at
the default starts and then fails every request. Render supplies `PORT` and the
application binds it. No OS packages are needed: `argon2` ships prebuilt Linux
x64 binaries inside its own package.

Do not add a second lockfile, another package manager, or remove the npm
workspace structure.

#### Why the build needs `NODE_ENV` handled carefully

The production service must run with `NODE_ENV=production`, and Render sets it as
an environment variable. npm omits `devDependencies` whenever
`NODE_ENV=production`, and this repository builds TypeScript — so `typescript`,
`tsx` and the `@types/*` packages are all `devDependencies`.

If the build step inherits `NODE_ENV=production`, `npm ci` installs runtime
packages only, and the backend build fails with errors that look like source
problems but are really missing type packages:

```
TS7016: Could not find a declaration file for module 'express'
TS7016: Could not find a declaration file for module 'pg'
TS2591: Cannot find name 'process'
TS2503: Cannot find namespace 'NodeJS'
TS2584: Cannot find name 'console'
TS2304: Cannot find name 'URL'
```

The root `.npmrc` sets `include=dev` so this cannot happen: devDependencies
install unconditionally. This is already npm's default when `NODE_ENV` is unset,
so it changes nothing locally. It is not a size or security regression — these
packages are build-time only, are never imported by the running server, and are
not reachable from any request.

The equivalent alternative is to write the build command as
`npm ci --include=dev && npm run build --workspace backend`. The `.npmrc` is
preferred because it cannot be forgotten by a future operator.

### Environment variables

Set these in Render's environment settings. Never in Git.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Render-assigned |
| `DATABASE_URL` | Neon **pooled** connection string |
| `WEBAUTHN_RP_ID` | `oou-attendance-system.vercel.app` |
| `WEBAUTHN_ORIGIN` | `https://oou-attendance-system.vercel.app` |
| `WEBAUTHN_RP_NAME` | `OOU Attendance System` |

`NODE_ENV=production` is what enables the production guards: session cookies are
forced to carry `Secure`, and `DATABASE_SSL=false` and
`AUTH_COOKIE_SECURE=false` become outright startup errors.

See [`backend/.env.example`](backend/.env.example) for the full variable
reference, including the optional pool settings.

### Database

The runtime uses the Neon **pooled** endpoint; migrations use the Neon
**direct** endpoint.

| Connection | Endpoint | Used by |
| --- | --- | --- |
| Pooled (`-pooler` host) | running Render service | day-to-day traffic |
| Direct (no `-pooler`) | `npm run migrate --workspace backend` | migrations only |

Migrations are **not** part of application startup, and must never be placed in
the Render start command. The production start path only loads configuration,
creates the app, runs a read-only `SELECT 1` connectivity check, and listens. It
does not migrate, seed, reset, truncate or alter schema.

Run migrations deliberately, once, before production traffic:

```bash
# With DATABASE_URL set to the Neon DIRECT connection string:
npm run migrate --workspace backend
```

TLS validation stays on. `sslmode=verify-full` is accepted, and omitting
`sslmode` entirely is also accepted. `sslmode=require`, `prefer`, `disable` and
`no-verify` are refused at startup, so a Neon connection string that still
carries Neon's default `sslmode=require` must be corrected first. Do not set
`DATABASE_SSL=false` in production.

### WebAuthn

The canonical production origin is `https://oou-attendance-system.vercel.app`,
which is the Vercel frontend — **not** the Render host.

WebAuthn binds a credential to the origin the ceremony actually runs in. Because
the browser loads pages from and talks only to the Vercel origin, the Render
hostname must never be used as the RP ID or the expected origin, and there is no
preview-host workaround. `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are required in
production; the application refuses to start without them.

### Health check

`/api/health` is the Render health check path. It queries the database and
reports `200` with `"database":"connected"` when the database is reachable, and
`503` with `"database":"unavailable"` when it is not. It never returns
credentials or connection details, and no debug endpoint exists to make it pass.

### Security

- **Do not commit production secrets.** No `DATABASE_URL`, database password,
  Render token or Neon credential belongs in Git, in a commit message, or in a
  log. Real values live in Render's encrypted environment settings, and locally
  in `backend/.env`, which is ignored by Git.
- **Do not use `DATABASE_SSL=false`** in production. It is rejected outright
  when `NODE_ENV=production`.
- **Do not run seed, reset or E2E setup against production.**
  `npm run seed:e2e`, `npm run unseed:e2e` and `npm run test:db:prepare` target
  the local/E2E test database only.
- **Do not expose debug or test endpoints** to make a health check or
  deployment succeed.
- **Do not add CORS.** Requests are same-origin through the Vercel rewrite by
  design.
- **Do not weaken WebAuthn verification** or relax session cookie attributes to
  make a deployment succeed.

### Known open item: trust proxy

`backend/src/config/trustProxy.ts` still trusts a single proxy hop, a value
chosen when Vercel's edge was the only proxy in front of Express. With Render in
the path the forwarded-header chain is longer, so this needs revisiting — but the
correct value cannot be guessed and must be observed on a real deployment. It is
documented in the source file and in the runbook.

For the full deployment sequence, see
[`docs/render-neon-deployment.md`](docs/render-neon-deployment.md).

## Database

The backend currently uses the PostgreSQL `pg` driver directly via a connection pool (`backend/src/db/pool.ts`). Credentials are read from the environment variables in `backend/.env`. Schema design and migrations will be added in a future step, and the `database/` directory is reserved for that purpose.

## License

This project is for educational purposes at Olabisi Onabanjo University.
