# Running on the local network (LAN mode)

LAN mode lets a student phone that is connected to the local router's Wi-Fi load
the attendance app from the server PC. It does exactly one thing: it makes the
frontend and backend **listen on the local network** instead of on loopback only.

> **LAN mode only makes the application listen on the local network. It does not
> configure Windows routing, Internet Connection Sharing, NAT, or firewall rules.**
> If a device cannot reach the app, the cause is on the network side, not in this
> project. See [Manual steps](#manual-steps-network-side) at the end.

---

## The three traffic paths

Normal local development — everything on one machine:

```text
PC browser  →  http://localhost:4173  →  frontend + backend + PostgreSQL
```

LAN mode — a student phone on the router's Wi-Fi:

```text
Student phone
    ↓  (router Wi-Fi)
Router LAN 192.168.0.1
    ↓  (LAN cable)
PC network interface 192.168.0.244
    ↓
Vite dev server  →  Express API  →  PostgreSQL   (all on the PC)
```

The server PC's own Internet connection is a separate, unrelated path and is
expected to keep working on the PC's other interface:

```text
PC  →  Wi-Fi interface  →  router  →  Internet / cloud services
```

The PC is **not** an Internet gateway for LAN devices, and LAN mode does not turn
it into one. A phone on the router's Wi-Fi uses the router for its own Internet
access, not the PC.

---

## How the phone reaches the backend

The frontend never calls the backend by address. `frontend/src/api/client.ts`
always requests the relative path `/api/...`, and the Vite dev server proxies
those requests to the API:

```text
http://192.168.0.244:4173          ← the page the phone loaded
  fetch('/api/auth/student/login')  ← same-origin, relative
    ↓
Vite dev server proxies /api  →  http://127.0.0.1:5000   ← resolved on the PC
    ↓
Express API
```

Three consequences worth stating explicitly:

1. **`localhost:5000` never appears in frontend code.** On a phone, `localhost`
   means the phone. Because the address is never used by the browser, it cannot
   break when the app is loaded from a LAN address.
2. **No CORS policy is needed.** Every browser request is same-origin, so the API
   serves no cross-origin responses and needs no CORS headers at all. Nothing was
   weakened to achieve this.
3. **The session cookies keep working.** The API sets host-only cookies (no
   `Domain` attribute, `HttpOnly`, `SameSite=Lax`, `Secure` in production), and the
   browser scopes them to whichever host it loaded the app from — `localhost` on
   the PC, the LAN address on a phone. The dev-server proxy forwards the
   `Cookie` header untouched and does not rewrite cookie domains, so a session
   created on the PC browser is a session on the PC browser, and a session created
   on a phone is a session on that phone.

   `Secure` is omitted here because a browser drops a `Secure` cookie from a
   plain-HTTP page, and LAN mode is plain HTTP. `AUTH_COOKIE_SECURE` can add the
   attribute for an HTTPS deployment; it can never remove it from production. See
   [`lan-https-webauthn.md`](lan-https-webauthn.md).

---

## Configuration

Two files, two independent switches. Copy each example file once; then flip only
the lines you need.

### Backend — `backend/.env`

```bash
cd backend
copy .env.example .env
```

Normal local development (the default — leave `HOST` unset):

```ini
HOST=127.0.0.1
PORT=5000
```

LAN mode:

```ini
HOST=0.0.0.0
PORT=5000
```

`HOST=0.0.0.0` listens on every interface. Set `HOST` to one specific address
instead to expose the API on that interface only. `HOST` and `PORT` are optional;
an unset or blank value means the default, and an invalid value fails at startup
with a clear message rather than being silently ignored.

#### Students: `STUDENT_ACCESS_MODE`

This PC is the deployment that serves students. It says so explicitly:

```ini
HOST=0.0.0.0
PORT=5000
STUDENT_ACCESS_MODE=edge
```

| Value | Effect |
|---|---|
| `edge` | Students sign in and use attendance. This is the K12 PC's setting. |
| `cloud` | Student sign-in and every `/api/student/*` API answer `403 STUDENT_ACCESS_DISABLED`. This is the public Render deployment's setting. |
| unset | Treated as `cloud`. |

Two things this is not:

- **Not an IP allowlist.** No part of the student policy reads the client's
  address, a forwarded header, or `HOST`. Behind the Vercel rewrite those are
  proxy addresses of uncertain meaning, and a client-influenceable header must
  never decide who signs in.
- **Not `SYNC_ENABLED`.** That variable means "run the background sync worker"
  and says nothing about who may sign in.

Unset defaults to `cloud` on purpose: a deployment nobody has configured must
never be the reason students are reachable from the open Internet. An
unrecognized value fails at startup rather than defaulting.

Confirm what a running process resolved with the startup log line, or
`GET /api/health`, which reports `studentAccessMode`.

This switch decides **who the software serves, not who can reach the PC.** If the
edge is ever exposed beyond the campus network — port forwarding, Internet
Connection Sharing, an open firewall rule — students will be served to whoever
reaches it. Keeping the edge private is the router's and the firewall's job; see
[Manual steps (network side)](#manual-steps-network-side).

### Frontend — `frontend/.env`

```bash
cd frontend
copy .env.example .env
```

Normal local development:

```ini
VITE_DEV_HOST=127.0.0.1
VITE_DEV_PORT=4173
VITE_API_PROXY_TARGET=http://127.0.0.1:5000
```

LAN mode:

```ini
VITE_DEV_HOST=0.0.0.0
VITE_DEV_PORT=4173
VITE_API_PROXY_TARGET=http://127.0.0.1:5000
```

`VITE_API_PROXY_TARGET` is resolved **on the PC**, so `127.0.0.1` is correct in
LAN mode too. Change it only if you also moved the backend to another port or
host.

### The address to open on a phone

The device opens `http://<the PC's LAN address>:<VITE_DEV_PORT>` — for example
`http://192.168.0.244:4173`.

That address is a property of the machine's network configuration, not of this
code:

* read it from the machine (`ipconfig` on Windows, `ifconfig` on macOS/Linux);
* never hard-code it in application source or in a test;
* if the PC's address changes — a different cable, a different router, DHCP — the
  configuration still works and only the URL you type changes.

You do not need to open the backend port on a phone at all. `:4173` is the only
port a device needs, and only if you have also set `HOST=0.0.0.0` on the backend
(e.g. for a client that talks to the API directly rather than through the proxy).

---

## Starting LAN mode

```bash
# terminal 1 — backend
cd backend
npm run dev

# terminal 2 — frontend
cd frontend
npm run dev
```

The backend prints its effective binding at startup:

```text
OOU Attendance System API listening on http://0.0.0.0:5000 (all interfaces - reachable from the local network).
Database connection established.
```

Vite prints a `Network:` line with the addresses it is listening on. Then, on a
phone connected to the router's Wi-Fi, open `http://<PC-LAN-IP>:4173`.

To go back to normal local development, set `HOST=127.0.0.1` in `backend/.env`
and `VITE_DEV_HOST=127.0.0.1` in `frontend/.env`. Nothing else needs reverting,
and no production or cloud configuration changes.

---

## WebAuthn / passkeys on a LAN IP address

**Student passkey features do not work when the app is loaded from the PC's LAN
address.** This is a browser-level constraint, not a configuration bug. Three
independent rules each block it, and each one alone is enough:

1. WebAuthn is only available in a **secure context**. Browsers treat
   `http://localhost` as trustworthy, but a plain-HTTP origin on a private address
   such as `http://192.168.0.244:4173` is not. `navigator.credentials` and
   `PublicKeyCredential` are therefore unavailable on the page, and
   `frontend/src/lib/webauthn.ts` correctly reports the browser as unsupported.
2. The **RP ID must be a real registrable domain** matching the origin. A passkey
   registered for RP ID `localhost` is scoped to `localhost` and cannot be used
   from `192.168.0.244`, because an IP address is not a valid RP ID at all.
3. Even over HTTPS, the **certificate must be trusted by the phone**. Chrome has
   disabled WebAuthn on pages with untrusted certificates since Chrome 110, so a
   self-signed certificate and "Proceed anyway" does not restore passkeys.

Making passkeys work on a phone therefore needs a real domain name, a certificate
the phone already trusts, and DNS that resolves the name to the PC on the K12
network. Those are hosting and PKI decisions, deliberately outside the scope of
LAN mode. They are analysed in full, including why each tempting shortcut fails,
in [`lan-https-webauthn.md`](lan-https-webauthn.md).

What this affects: student device enrollment, passkey login, and attendance device
verification — the three ceremonies in `backend/src/lib/webauthn.ts`. Everything
else (admin, lecturer, student registration, attendance history, course
registration) works from a phone over the LAN, because those flows use the
session cookie.

What was **not** done, on purpose:

* `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` still require the production values when
  `NODE_ENV=production`, and are still strict. Nothing was relaxed to accommodate
  an IP address.
* No "allow any RP ID" or "skip origin check" branch was added, in any
  environment.
* No HTTPS or certificate configuration was added, because it could not be
  exercised end to end without a real name and a trusted certificate.
* No insecure-origin browser flag is required or recommended.

---

## What is unchanged

* PostgreSQL: not touched. No database was created, dropped, reset, seeded or
  migrated for LAN mode. The database still listens on `localhost` and is reached
  only by the backend on the PC.
* Authentication model, session handling, rate limiting, authorization and
  WebAuthn validation: unchanged. The one addition is `AUTH_COOKIE_SECURE`, an
  opt-in that can only add the `Secure` attribute outside production and is
  refused in production; see [`lan-https-webauthn.md`](lan-https-webauthn.md).
* CORS: no middleware exists and none was added.
* Cloud deployment: the defaults are unchanged and stay loopback-safe. LAN mode is
  opt-in through `HOST` / `VITE_DEV_HOST` only.
* The Vite dev server is a development tool. It is not part of a production
  build, so `VITE_DEV_HOST` has no effect on a deployed frontend.

---

## Manual steps (network side)

These are outside the application and outside this repository. LAN mode does not
perform them.

1. Confirm the PC's LAN address and that it is on the same subnet as the router's
   LAN address (`ipconfig`).
2. If Windows Firewall is enabled, allow inbound TCP on the frontend port
   (`4173`) for the relevant profile — or for Node.js, if you accept its prompt.
   Nothing else needs to be opened: the phone only talks to the dev server, and
   the dev server talks to the API and the database over loopback.
3. Confirm the phone is on the router's Wi-Fi, not on a guest network, and that
   the router does not isolate clients from each other ("AP isolation" /
   "client isolation" must be off).
4. Leave the PC's Internet interface alone. No static routes, no Internet
   Connection Sharing, no NAT, no port forwarding: the PC must not become an
   Internet gateway for LAN devices.
5. If a phone still cannot load the app, test `http://<PC-LAN-IP>:4173` from a
   browser on the same network. If that fails, the problem is the network, not the
   application.

---

## Verifying the configuration

Focused tests cover the configuration behaviour and touch no database:

```bash
cd backend
npx tsx --test tests/serverConfig.test.ts
npx tsx --test tests/authCookieConfig.test.ts

cd ../frontend
npm test
```

These suites assert that the default binding is loopback, that a configured
interface and port are honoured, that invalid values are rejected, that no
server-side configuration file hard-codes a private LAN address, and that the
session cookie cannot lose its `Secure` attribute in production. None of them
touch a database.
