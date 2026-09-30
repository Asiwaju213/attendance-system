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
├── docs/              # Project documentation (see docs/lan-mode.md)
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

## Database

The backend currently uses the PostgreSQL `pg` driver directly via a connection pool (`backend/src/db/pool.ts`). Credentials are read from the environment variables in `backend/.env`. Schema design and migrations will be added in a future step, and the `database/` directory is reserved for that purpose.

## License

This project is for educational purposes at Olabisi Onabanjo University.
