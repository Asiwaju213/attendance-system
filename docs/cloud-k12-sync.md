# Cloud ↔ K12 Edge Synchronization

How the local K12 server keeps working for students when the Internet is slow,
unavailable, or the cloud is down.

## The shape of the system

Production is Vercel → Render API → Neon PostgreSQL. The K12 classroom has a
Windows PC with Ethernet to the K12 router and Wi-Fi to the normal Internet,
running its own frontend, backend, PostgreSQL, and (as of Task 1) a sync worker.

Two independent databases. They are not replicas and there is no shared table
between them.

Synchronization is **application level**: the edge asks the cloud's HTTP API for
changes and writes them into its own database with ordinary SQL. There is no
PostgreSQL replication, no foreign database connection, and the cloud never
reaches into the local database.

No Windows networking change is involved. The PC already has outbound Internet
access, so synchronization is just an outbound HTTPS request from the same
process that serves students. Nothing here needs Internet Connection Sharing,
NAT, port forwarding, or a firewall change, and nothing here exposes the local
server to the public Internet.

## Who is authoritative for what

The cloud is authoritative for users, students, lecturers, courses, course
offerings, academic sessions, attendance-session lifecycle, final attendance
records, and device administration.

The edge holds a **synchronized copy** plus **local state**. It never has
authority over the cloud's lifecycle. A local copy must not modify or close a
cloud attendance session; it can only learn that the cloud closed one.

Master data flows cloud → edge. Attendance marks flow edge → cloud.

## Directions

```
MASTER DATA (Task 1-2)          CLOUD   writes event in the same transaction
  cloud → edge                                          → sync_change_events
                                                        ↓
                                  GET /api/internal/sync/changes
                                                        ↓
                                  LOCAL SYNC WORKER   one local transaction
                                                        → local PostgreSQL + cursor

ATTENDANCE MARKS (Task 3-4)      LOCAL   mark + queue row in the same transaction
  edge → cloud                                          → sync_outbound_attendance_marks
                                                        ↓
                                  POST /api/internal/sync/attendance-marks
                                                        ↓
                                  CLOUD   writes the canonical attendance record
                                                        → sync_inbound_attendance_receipts
```

The two directions are independent on purpose: a failure to reach the cloud stops
the edge receiving master data without stopping it from sending marks, and vice
versa. The worker uploads first, then downloads, because locally queued attendance
is the data the school cannot afford to sit on.

## The cursor model

The cloud keeps an append-only feed. Each row has a monotonic `cursor`
(`BIGSERIAL`), a `uuid` `event_id`, the entity type and id, the operation, and a
JSONB payload.

The edge stores one number: the cursor it has durably applied through. Each poll
asks for everything strictly after it.

```
local cursor = 1250
GET /api/internal/sync/changes?cursor=1250&limit=100
cloud replies with events 1251..1260 and nextCursor = 1260
local applies 1251..1260 and stores cursor = 1260, in ONE transaction
```

**The cursor is never advanced outside the transaction that applies the events.**
That single rule is the whole correctness argument:

- events applied but cursor stale → work is repeated, and the processed-event
  receipts make repeating it harmless;
- cursor advanced but events missing → events lost silently, which is the failure
  this design exists to make impossible.

Timestamps are never used for ordering. They are recorded for humans, but
`attendance_sessions` has no `updated_at`, and wall-clock values can move
backwards or collide, so there is no `WHERE updated_at > ?` anywhere in the sync
path.

### Ordering and gaps

The cloud always returns ascending cursor order, and the edge refuses a batch
that is not a strictly ascending, gap-free continuation of its stored cursor. A
gap means events were lost upstream; skipping it would make the edge quietly
inconsistent while reporting success, so the edge stops and reports instead. The
feed is append-only and not pruned, so under normal operation gaps cannot occur.

An entity type the edge does not understand also stops the cursor rather than
being skipped. Skipping would advance the cursor past data that was never
applied.

## Identifiers

Cloud and local `BIGSERIAL` sequences are independent, so cloud id 42 and local
id 42 are unrelated rows. No cloud numeric id is ever treated as a local
identity.

`sync_change_events.entity_id` carries the entity's **UUID** (`sync_id`), not its
integer id. `attendance_sessions.sync_id` was added for exactly this purpose, and
`sync_attendance_sessions.cloud_sync_id` is the local primary key that events
upsert against.

Cloud numeric ids still appear in the payload under explicitly cloud-prefixed
names (`cloudCourseOfferingId`, `cloudLecturerId`, …) because the edge needs them
to join to entities that Task 2 will synchronize.

## Idempotency

Delivery is at-least-once. A response lost in transit is re-requested, and a
restart re-reads from the stored cursor.

Every applied event gets a row in `sync_processed_events`, keyed
`(consumer_id, event_id)`. The edge claims an event before applying it; a
duplicate violates the primary key, returns no row, and is skipped without
touching the session. Applying the same batch twice is therefore a no-op.

## Transactions and rollback

Every business transaction that changes an attendance session appends its change
event on the **same client, before the same COMMIT**:

- `createAttendanceSession` → `CREATED`
- `endSession` → `CLOSED`

If either the session change or the event insert fails, both roll back. There is
no path where a committed session has no event.

There is no "update session fields" operation in Task 1 because the application
has no endpoint for it: the only two mutations the API permits are start and end.
`UPDATED` is present in the event vocabulary for a future task, not emitted today.

## Edge authentication

The edge authenticates as a synchronization client using a dedicated shared
secret. It is completely separate from every other authenticator: it reads no
cookies, does not consult the session table, and knows nothing about WebAuthn or
device binding. A student, lecturer or admin session cookie cannot reach the sync
API — `requireEdgeSyncAuth` never looks at it.

The cloud stores **only** the SHA-256 hex digest (`SYNC_PROVIDER_SECRET_HASH`),
never the secret. Possessing the digest cannot produce a valid
`Authorization: Bearer` header. Comparison is `timingSafeEqual` over the two
digests.

The secret is sent only in a request header, never in a URL, never logged, never
returned in any response, and never placed in the React frontend. If the provider
has no hash configured the feed refuses every caller with `SYNC_NOT_CONFIGURED`
rather than defaulting to open.

## The API surface

`GET /api/internal/sync/changes?cursor=&limit=` — one ordered, bounded page.

`GET /api/internal/sync/status` — worker state (last cursor, last success, last
attempt, current error, enabled/running). Contains no credential.

That is the entire surface. There is no entity lookup by id, no arbitrary table
read, no write, and no way to pass SQL, a filter, or an identifier through to the
database layer. Every statement has a fixed shape with bound parameters.

Batch size is bounded and defaults to 100 (maximum 500). An oversized `limit` is
clamped rather than rejected so a client asking for too much still makes
progress; a non-numeric `cursor` or `limit` is rejected rather than coerced.

## Worker lifecycle

The worker is a background module inside the local backend. **It is not a second
HTTP server** and it opens no port of its own.

- **Disabled unless `SYNC_ENABLED` is set**, and enabling it requires
  `SYNC_CLOUD_BASE_URL`, `SYNC_EDGE_ID` and `SYNC_EDGE_SECRET`, so a
  half-configured worker cannot silently sync nothing.
- **Never runs when `NODE_ENV=test`.**
- The cloud never sets `SYNC_ENABLED`: the cloud is the provider and does not
  consume itself.
- Started *after* the listener is bound and never awaited, so **startup never
  depends on cloud reachability**.

Retries use bounded exponential backoff: 2s, 5s, 10s, 30s, then 60s. An idle poll
uses `SYNC_INTERVAL_MS` (default 15s). There is no busy-loop.

`SIGINT`/`SIGTERM` stop the worker and close the HTTP server and the database
pool.

## When the Internet is down

Nothing local depends on the cloud:

1. The backend starts normally and serves students over the K12 LAN.
2. The worker's first attempt fails; the failure is logged and retried with
   backoff.
3. The cursor does not advance, so no event is skipped.
4. Attendance marking continues to work locally, because the mark and its queue row
   are written in the same transaction and neither needs the cloud (Task 3).
5. The attendance queue grows. Nothing is lost and nothing is overwritten.
6. `GET /api/admin/sync-status` reports the rising pending count and, once the cloud
   has been unreachable for several ticks, state `OFFLINE` (Task 6).

When connectivity returns, the worker uploads the queued marks and resumes from its
stored cursor. A request whose response was lost is retried, and the cloud's receipt
table absorbs the duplicate.

## When the cloud refuses a mark

A mark can be un-acceptable for reasons retrying cannot fix: the cloud has never
heard of that attendance session, has no student with that matriculation number, or
has no enrolment for that offering. Those are parked as `REJECTED` rather than
retried forever, and are listed by `GET /api/admin/sync-rejected-marks` with the
reason.

The mark is still recorded locally and is not lost. Once the underlying problem is
fixed — usually an enrolment or a session that has now synchronized —
`POST /api/admin/sync-rejected-marks/:queueId/requeue` returns it to the queue.

## Health and rejection reporting

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/internal/sync/status` | edge secret | Worker state, machine-to-machine. |
| `GET /api/admin/sync-status` | admin session | Both directions plus an overall verdict. |
| `GET /api/admin/sync-rejected-marks` | admin session | Refused marks and why. |
| `POST /api/admin/sync-rejected-marks/:queueId/requeue` | admin session | Re-queue one refused mark. |

The split is deliberate. The edge secret identifies one PC, so anything a human needs
to see or act on has to be reachable by a person signed in as an admin — and the
rejection list names students and sessions, so it must never be served to a student
or lecturer session, nor through the machine credential.

## Configuration

Consumer (the K12 PC) — see `backend/.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_ENABLED` | `false` | Master switch for the worker. |
| `SYNC_CLOUD_BASE_URL` | — | Cloud API base URL, no trailing slash. Required when enabled. |
| `SYNC_EDGE_ID` | — | Identifies this edge. Required when enabled. |
| `SYNC_EDGE_SECRET` | — | Shared secret, server-side only. Required when enabled. |
| `SYNC_INTERVAL_MS` | `15000` | Idle poll interval. |
| `SYNC_BATCH_LIMIT` | `100` | Max events per request (max 500). |
| `SYNC_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout. |

Provider (the cloud / Render):

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_PROVIDER_SECRET_HASH` | unset | SHA-256 hex digest of the edge secret. Unset = feed refuses everyone. |

Generate a pair with:

```bash
node -e "const s=require('crypto').randomBytes(32).toString('base64url');\
console.log('SYNC_EDGE_SECRET='+s);\
console.log('SYNC_PROVIDER_SECRET_HASH='+\
require('crypto').createHash('sha256').update(s).digest('hex'))"
```

Put the secret in the PC's `backend/.env` and the digest in Render's encrypted
environment variables. Rotate by generating a new pair and updating both sides.

## Schema

Migration `012_cloud_k12_sync_change_feed.sql` adds:

| Table | Side | Purpose |
|---|---|---|
| `attendance_sessions.sync_id` | both | UUID identity that crosses databases. |
| `sync_change_events` | provider | Append-only feed with monotonic cursor. |
| `sync_consumer_state` | consumer | The local checkpoint. |
| `sync_processed_events` | consumer | Idempotency receipts. |
| `sync_attendance_sessions` | consumer | Local projection of a cloud session. |

The same migration is applied to both sides, since both run this application;
each side simply ignores the tables it does not use. There is deliberately **no
foreign key** from `sync_change_events` to `attendance_sessions`: the feed must
outlive the rows it describes, and an FK would break the many test fixtures and
the E2E seeder that insert and delete attendance sessions directly.

Later migrations add:

| Table | Side | Purpose |
|---|---|---|
| `013` `sync_id` columns, `sync_lecturers` | both | Master-data identity and the lecturer projection. |
| `014` `sync_outbound_attendance_marks` | consumer | The durable local attendance queue (Task 3). |
| `015` `sync_inbound_attendance_receipts` | provider | Delivery receipts, so a replayed upload is a no-op (Task 4). |

`015` is deliberately not a reuse of `sync_processed_events`. That table records
"this edge applied this feed event at this cursor" and is keyed by consumer; the new
one records "the cloud has accepted this specific delivery". Different owners and
lifetimes, so conflating them would let a cursor reset silently discard receipts.

## What is never synchronized

- **Students.** Not in either direction. The cloud's enrolment is the authority, and
  the edge's student rows are its own. A mark is resolved by matriculation number,
  the one key both databases share.
- **Users, passwords, sessions, WebAuthn credentials, device bindings.** Never
  placed in the feed or in an upload, and asserted absent.
- **Attendance records as a projection.** The cloud's `attendance_records` row is
  the canonical one. The edge writes a mark and uploads it; it does not mirror a
  copy back and forth.

Master data (faculties, departments, levels, courses, offerings, academic sessions,
semesters, locations, networks, lecturers) is synchronized cloud → edge.

## Reference-data conflicts

Both databases are seeded from the same migrations, so the same course exists on both
sides under the same course code but with independently generated `sync_id` values.
A plain upsert on `sync_id` therefore collides with the natural key
(`courses_course_code_key` and friends).

`syncMasterDataAppliers.ts` resolves that in three steps: update by `sync_id` first,
fall back to the entity's natural key, and only then insert. An existing row adopts
the cloud's UUID and keeps its local integer id, so local foreign keys and local
attendance history survive the transition.

## Feeding an existing database

The feed only carries what changed after it started. To bring an edge that already
has data up to date, backfill the current state first:

```bash
cd backend
npx tsx scripts/backfillMasterDataFeed.ts
```

It emits dependency-ordered full-state events in one transaction (faculties →
departments → levels → academic sessions → semesters → courses → offerings →
locations → networks → lecturers), because an edge cannot write a course offering
before the rows it references exist locally.

## Running it

Local (cloud provider role):

```bash
cd backend
SYNC_PROVIDER_SECRET_HASH=<digest> npm run migrate
npm run dev
```

Edge (consumer role) — `backend/.env`:

```
SYNC_ENABLED=true
SYNC_CLOUD_BASE_URL=https://<render-host>
SYNC_EDGE_ID=k12-pc-01
SYNC_EDGE_SECRET=<shared secret>
```

Start and stop the worker with the backend process. It starts on boot when
enabled, and stops on `SIGINT`/`SIGTERM`. There is no separate command and no
second process.