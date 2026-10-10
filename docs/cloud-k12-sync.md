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

Course registrations follow the same rule:

- `registerCourses` (a student registering for offerings) → `CREATED`, one event
  per newly inserted registration
- `adminEnrollStudent` (an admin enrolling a student) → `CREATED`

Both emit inside the transaction that inserts the registration, so a committed
registration always has its event and a rolled-back one has neither. There is no
operation in the application that updates or deletes a registration row, so
`UPDATED` has no business-operation trigger yet for this entity: a future drop
or completion endpoint would be the place to emit it, and until then the status
field on the CREATED payload is the only registration state that synchronizes.

Device state follows the same rule:

- `completeDeviceEnrollment` → `CREATED` for the new device, plus `UPDATED` for
  the device it replaced when an upgrade revokes it. The revocation event is
  written before the creation event so the edge sees the old device leave
  `ACTIVE` before the new one enters it — its one-active-device rule would
  refuse the reverse order.
- `resetStudentDevice` (admin device reset) → `UPDATED`
- `resetStudentRegistration` (admin registration reset, which revokes the
  device with it) → `UPDATED`, only when a device was actually revoked

All three emit on the same client, before the same COMMIT, so a committed
enrollment or reset always has its event and a rolled-back ceremony has
neither. Counter updates and `last_seen_at` refreshes during login are device
*activity*, not device state, and are deliberately not synchronized: they would
fill the feed with events that change no decision.

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
| `SYNC_CLAIM_TIMEOUT_MS` | `60000` | Upload-claim lease in milliseconds (Task 5). An `IN_FLIGHT` upload older than this may be reclaimed by the next drain or released by the admin action. Minimum 1000, maximum 600000. |

A **consumer (the K12 PC) must NOT set** `SYNC_PROVIDER_SECRET_HASH`. A PC that
does would be seen as a provider too, and the worker's startup guard (see _Worker
lifecycle_) fails the process rather than starting the wrong role.

Provider (the cloud / Render):

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_PROVIDER_SECRET_HASH` | unset | SHA-256 hex digest of the edge secret. Unset = feed refuses everyone. |
| `SYNC_PUBLISH_ON_STARTUP` | `true` | Publish this cloud's current master data into the feed exactly once at startup (migration 024 marker; an already-seeded feed is never re-seeded). `false` disables it; pre-existing rows must then be published manually with `backfillMasterDataFeed.ts` (see _Feeding an existing database_). |

A **provider (cloud / Render) must NOT set** `SYNC_ENABLED`, `SYNC_CLOUD_BASE_URL`,
`SYNC_EDGE_ID` or `SYNC_EDGE_SECRET`. It is the provider and must never run the
consumer worker; the startup guard fails fast if both roles look configured (see
_Worker lifecycle_).

Generate a pair with:

```bash
node -e "const s=require('crypto').randomBytes(32).toString('base64url');\
console.log('SYNC_EDGE_SECRET='+s);\
console.log('SYNC_PROVIDER_SECRET_HASH='+\
require('crypto').createHash('sha256').update(s).digest('hex'))"
```

Put the secret in the PC's `backend/.env` and the digest in Render's encrypted
environment variables. Rotate by generating a new pair and updating both sides.

## Which deployment serves students

Synchronization decides who holds authoritative data. It does **not** decide who
may sign in as a student. That is `STUDENT_ACCESS_MODE`, a separate variable, and
the two are independent on purpose: an edge may sync or not, and the cloud
provides the feed either way.

| Deployment | `STUDENT_ACCESS_MODE` | Result |
|---|---|---|
| Cloud / Render | `cloud` (or unset) | Student sign-in and every `/api/student/*` API answer `403 STUDENT_ACCESS_DISABLED`. Admin and lecturer work normally. |
| Local K12 PC | `edge` | Students sign in and use attendance normally. |

Unset means `cloud`, so a deployment nobody configured cannot expose students to
the open Internet. An unrecognized value fails at startup instead of defaulting.

This is **not an IP allowlist**. The deployed API is reached through the Vercel
rewrite in front of Render, so the client address the application sees is a proxy
address of uncertain meaning (see `config/trustProxy.ts`), and a forwarded header
is client-influenceable. No part of the policy reads an address: the mode is
configuration, decided once by an operator.

What the mode does **not** do is keep the edge private. It decides who the
software will serve, not who can reach the PC. Keeping the edge off the Internet
remains the router's and the firewall's responsibility — see
[`lan-mode.md`](lan-mode.md).

To confirm which mode a running process resolved, read the startup log line, or
`GET /api/health`, which reports `studentAccessMode`.

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
| `019` `students.sync_id` | both | Student identity for cloud → edge mirroring. |
| `020` `course_registrations.sync_id` | both | Registration identity for cloud → edge mirroring. |
| `021` `student_devices.sync_id`/`device_ref`, `sync_student_devices` | both | Device state identity and the edge's device-state projection. |
| `023` `cloud_session_local_marking` | consumer | Local marking of cloud-created sessions; adds the partial unique index that makes one mark per (student, session). |
| `024` `sync_feed_publication_state` | provider | Exactly-once "has this feed been seeded" marker. |
| `025` `sync_outbound_claim` | consumer | `IN_FLIGHT` status + claim lease on the outbound queue; adds `claimed_at`/`claimed_by` and the partial reclaim index. |

`015` is deliberately not a reuse of `sync_processed_events`. That table records
"this edge applied this feed event at this cursor" and is keyed by consumer; the new
one records "the cloud has accepted this specific delivery". Different owners and
lifetimes, so conflating them would let a cursor reset silently discard receipts.

## What is never synchronized

- **Student authentication material.** `password_hash`, `username`,
  `students.webauthn_user_handle`, every `student_devices` credential column
  (credential id, public key, counter, transports, AAGUID, discoverable flag,
  label), challenges and remembered-account tokens are never selected by the
  emitter and never placed in the feed, and the tests assert their absence.
  The edge creates each synchronized student with `password_hash = NULL`, so
  the mirrored row is a profile, not a login.
- **Users, passwords, sessions, WebAuthn credentials.** Never placed in the
  feed or in an upload, and asserted absent. What does cross for a device is
  its opaque `device_ref` and its `ACTIVE`/`REVOKED` status — a device
  *identity and state*, never its credential — and even that grants nothing on
  its own: a binding cookie is only ever accepted together with a password
  verified against the local `users` row.
- **Attendance records as a projection.** The cloud's `attendance_records` row is
  the canonical one. The edge writes a mark and uploads it; it does not mirror a
  copy back and forth.

Master data (faculties, departments, levels, courses, offerings, academic sessions,
semesters, lecturers) is synchronized cloud → edge.

Students are synchronized cloud → edge as **profile data only**: the `student`
entity carries the stable `students.sync_id`, matriculation number, name, account
status and the department/level references, and the applier writes it into the
edge's real `users` + `students` rows (creating the local user with
`password_hash = NULL`). Local identity is not created on the edge: an existing
local student with the same matriculation number adopts the cloud `sync_id`
instead of being duplicated, and a matric or `sync_id` collision fails the batch
rather than guessing which row is the same person. Students are never deleted
from the edge - an inactive student is carried as `status = 'INACTIVE'`, because
attendance history references the row.

Course registrations are synchronized cloud → edge into the edge's real
`course_registrations` table - no second registration table. The `course_registration`
entity carries the stable `course_registrations.sync_id`, the student and course
offering as cloud UUID references, and the status (`ENROLLED`, `DROPPED` or
`COMPLETED`). The applier resolves both parents by UUID, so a registration whose
student or offering has not synchronized yet fails the batch and holds the cursor
instead of writing a NULL foreign key. An edge that already holds the pair adopts
the cloud `sync_id` onto its existing row rather than duplicating it, and a
`sync_id` or pair collision fails the batch rather than guessing which row is the
same registration. A registration row holds no credential and no student profile
beyond the parent reference, so there is no authentication material in this
entity either, and the tests assert it. The row is never deleted from the edge -
a dropped or completed registration is carried as `status`, because attendance
eligibility and history reference it.

Device state is synchronized cloud → edge as a **binding decision only**: the
`student_device` entity carries the device's opaque `device_ref`, its own
`sync_id`, the student as a cloud UUID reference, and the status (`ACTIVE` or
`REVOKED`). The applier writes it into the edge's `sync_student_devices`
projection — not into `student_devices`, whose rows are credentials enrolled
locally — so a cloud-enrolled device and a locally enrolled one stay
distinguishable and a cloud row never sits in front of the attendance
verification queries. The projection holds no credential id, no public key, no
counter and no discoverable flag, because no payload field carries one. A
device event resolves its student by UUID and never creates one, so a device
whose student has not synchronized yet fails the batch and holds the cursor;
a device never changes owner, and an event that would move an existing
projection row onto a different student — or make a second device `ACTIVE` for
a student who already holds one — fails the batch rather than guessing. What
the edge uses it for is one lookup: the device-binding cookie holds the
`device_ref`, and `findStudentLoginCandidateByBinding` resolves it against
local device rows first and the projection second, so the password login keeps
working without the credential ever crossing the boundary. The binding is
still not a credential — it is checked together with a password against the
local `users` row, exactly as before.

Attendance sessions are synchronized too, without any network or location: a
session payload carries the offering, lecturer, times, late threshold and status
only (see `SYNC_ATTENDANCE_SESSION_VERSION` in `config/sync.ts`). The
`location` and `attendance_network` entity types were removed from the vocabulary
by migrations 017 and 018; an edge that still has such an event queued behind its
cursor retires it instead of failing, so it can drain past it.

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
lecturers → students → student devices → course registrations), because an edge
cannot write a course offering, a student or a device state before the rows it
references exist locally.

## Deploying and rolling back a sync release

Deploying the outbound-claim work (migrations 024 and 025) touches both sides.
Follow this order and verify as you go. It is the sync counterpart of the
Render runbook's "database migration, then deployment" rule
(`docs/render-neon-deployment.md`, step 4 and section 14).

### 1. Migrate both databases first

The new code refuses to run against the old schema:

- migration 025 adds `claimed_at`/`claimed_by` and the `IN_FLIGHT` status to
  `sync_outbound_attendance_marks`. Without it every claim, health aggregate,
  stale-claim count and admin release fails (missing column, and the status
  CHECK still rejects `IN_FLIGHT`).
- migration 024 adds the provider-only `sync_feed_publication_state` marker.

Apply **all pending migrations to the provider database and to every edge
database before any new backend boots**:

```bash
# Provider database (Neon direct endpoint; never in the Render start command):
DATABASE_URL=<direct Neon connection string> npm run migrate --workspace backend

# Each edge / K12 PC, against its own local database:
cd backend
npm run migrate
```

Then verify **read-only** that both databases reached 025 before deploying code:

```sql
SELECT filename FROM schema_migrations ORDER BY id;
```

The last two rows must be `024_sync_feed_publication_state.sql` and
`025_sync_outbound_claim.sql` on both sides.

### 2. Deploy the provider (cloud / Render)

Redeploy the backend. On startup the provider publishes its current master data
into the feed exactly once if it has not been seeded (migration 024 marker);
expect the log line `Published N master-data feed events...` or
`Sync feed already seeded;...`. Confirm with the admin snapshot:

- `GET /api/admin/sync-status` → `"role": "PROVIDER"` and
  `"publication": { "seeded": true, ... }`.

### 3. Deploy the edges (K12 PCs)

Roll out each PC: pull the new code, run its local migrations first (step 1),
then restart the backend. The worker now uses the claim/backoff path.

Confirm on each PC:

- `GET /api/admin/sync-status` → `"role": "EDGE"`, `"staleInFlight": 0`, and
  sensible outbound counts.
- Mark one attendance row and watch it leave the queue: `PENDING` → `IN_FLIGHT`
  → `SENT`. A refused mark parks as `REJECTED` for the admin requeue action.

### 4. Rollback

Rollback is **code only**; the database stays on migration 025.

- Provider: revert the commit and redeploy. Migrations 024/025 are additive and
  forward-compatible: the older code never references the new columns and never
  writes `IN_FLIGHT`, so it runs unchanged against the 025 schema.
- Edge: **before** reverting to the pre-claim code, return any `IN_FLIGHT` rows
  to `PENDING` — either let the running worker's lease reclaim them (automatic
  once `claimed_at` is older than the claim timeout) or call
  `POST /api/admin/sync-outbound/release-stale-claims`. Pre-claim code selects
  only `status = 'PENDING'`, so a row left `IN_FLIGHT` would be invisible to it
  until an operator re-released it.
- Never drop the 025 columns as a "rollback": there is no down-migration, and
  the old code is compatible with them. If a database rollback is ever truly
  required it is a Neon branch/snapshot restore, which risks attendance data —
  ask before discarding anything.

### Tooling that must not be used as routine recovery

`backend/scripts/rebuildCloudSyncFeed.ts` **truncates** the change feed and
restarts its identity sequence, and `backend/scripts/resetEdgeCheckpoint.sql`
deletes processed-event receipts and zeros an edge cursor. Both renumber or
rewind the feed, which silently breaks the cursor and idempotency guarantees
this design is built on. They exist for reconstruction after a data restore, are
incompatible with the attendance-data and cursor constraints, and **must not be
run as part of deployment, recovery or rollback**. Missing feed events are
repaired by the append-only `backfillMasterDataFeed.ts` script (see _Feeding an
existing database_).

## Running it

Local (cloud provider role):

```bash
cd backend
SYNC_PROVIDER_SECRET_HASH=<digest> npm run migrate
npm run dev
```

By default the provider also publishes its current master data into the feed
exactly once at startup (`SYNC_PUBLISH_ON_STARTUP`, see _Configuration_). The
`npm run migrate` command above is the required one-off; the startup publish is
the automated, marker-guarded seed.

Edge (consumer role) — `backend/.env` (`SYNC_CLAIM_TIMEOUT_MS` is optional;
default 60000 ms, see _Configuration_):

```
SYNC_ENABLED=true
SYNC_CLOUD_BASE_URL=https://<render-host>
SYNC_EDGE_ID=k12-pc-01
SYNC_EDGE_SECRET=<shared secret>
```

Start and stop the worker with the backend process. It starts on boot when
enabled, and stops on `SIGINT`/`SIGTERM`. There is no separate command and no
second process.