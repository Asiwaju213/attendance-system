// Task: one-time device bootstrap secrets (the `student_device_bootstrap` entity).
//
// The problem this feature solves: a device enrolled in the CLOUD has to become
// a device this K12 edge will honour, without either database ever exchanging a
// WebAuthn credential and without trusting a cookie that came from the other
// origin. The bridge is a one-time secret - minted in the enrollment
// transaction, shown to the student exactly once in the enrollment response,
// synchronized only as a SHA-256 hash, and spent by the edge in one atomic
// UPDATE that sets the device-binding cookie.
//
// So the tests come in three groups, mirroring the sync test's shape:
//
// - Emission: a committed enrollment publishes exactly one bootstrap event,
//   after its device event, carrying the hash of the secret the response just
//   showed - and never the secret. The hash identity (shown plaintext ->
//   hashSessionToken -> stored row -> published payload) is asserted end to
//   end, because "only the hash crosses" is worthless if the hash is of
//   something else.
//
// - Application: the edge writes the replica into
//   `sync_student_device_bootstraps`, resolves the student by UUID, refuses
//   every shape that could make a spent secret spendable again or a secret
//   spendable by the wrong student, and holds the cursor on every refusal.
//
// - Spending: the endpoint takes matric + password + secret, refuses every
//   failure with the SAME generic 401 a wrong password produces, sets only the
//   device-binding cookie on success (never a session), and cannot be replayed.
//
// The applier tests build their events in memory with a dedicated consumer,
// the same way studentDeviceSync.test.ts exercises its applier. The endpoint
// tests seed the projection directly, because their subject is the spend
// statement, not the feed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { SYNC_PAYLOAD_VERSION } from "../src/config/sync";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { SyncApplyError } from "../src/services/syncErrors";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncOperation,
  SyncedStudentDevice,
  SyncedStudentDeviceBootstrap,
} from "../src/types/sync";
import {
  buildRegistrationResponse,
  createTestAuthenticator,
} from "./webauthnTestHelpers";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const PREFIX = `DEVBOOT${Date.now().toString(36).toUpperCase()}`;
const CONSUMER_PREFIX = `${PREFIX}-`;
const TEST_PASSWORD = "device-bootstrap-test-password";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every field the bootstrap payload is allowed to carry. */
const ALLOWED_PAYLOAD_KEYS = [
  "cloudDeviceRef",
  "cloudStudentSyncId",
  "expiresAt",
  "secretHash",
  "status",
  "syncId",
  "version",
].sort();

/**
 * Material that must never appear in a bootstrap payload.
 *
 * Deliberately WITHOUT the substring "secret": the payload's whole job is to
 * carry `secretHash`, the SHA-256 digest that lets the edge recognize the
 * secret without ever holding it. What must not appear is the plaintext (the
 * separate scan below asserts every issued secret is absent), and anything
 * credential-, password- or session-shaped, none of which exists on a
 * `student_device_bootstraps` row the emitter could select.
 */
const FORBIDDEN_PAYLOAD_SUBSTRINGS = [
  "password",
  "password_hash",
  "$2b$",
  "credentialid",
  "credential_id",
  "publickey",
  "public_key",
  "counter",
  "aaguid",
  "transports",
  "discoverable",
  "label",
  "challenge",
  "webauthn",
  "user_handle",
  "session_token",
  "cookie",
  "matric",
];

let server: Server;
let baseUrl: string;
let facultyId = 0;
let departmentId = 0;
let levelId = 0;
let feedFloor = 0;

interface StudentFixture {
  userId: number;
  studentId: number;
  syncId: string;
  matric: string;
}

/** Every student this file created, so cleanup and event filters stay exact. */
const students: Record<string, StudentFixture> = {};
/** Cloud sync ids of every student above: the event filter matches on these. */
const myStudentSyncIds = new Set<string>();
const sessionTokens: Record<number, string> = {};

/**
 * Every plaintext secret this file was ever shown or generated, plus the one
 * per ceremony student. The final scan asserts none of them appears in any
 * event or any stored row - the property the whole design exists for.
 */
const issuedSecrets: string[] = [];
const secretByStudent: Record<number, string> = {};

/** The binding the happy-path test set, so later tests can reuse the browser. */
let bindDeviceRef: string | null = null;

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

function cookieHeader(userId: number): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${sessionTokens[userId]}` };
}

/** Pull one cookie's value out of a `Set-Cookie` collection. */
function cookieValue(setCookies: string[], name: string): string | null {
  const found = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!found) return null;
  const start = found.indexOf("=") + 1;
  const end = found.indexOf(";");
  return found.slice(start, end === -1 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeStudent(key: string, suffix: string): Promise<StudentFixture> {
  const user = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Student ${suffix}`, await hashPassword(TEST_PASSWORD)]
  );
  const userId = Number(user.rows[0].id);
  const matric = `${PREFIX}/${suffix}`;
  const student = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id, sync_id`,
    [userId, matric, departmentId, levelId]
  );
  const fixture: StudentFixture = {
    userId,
    studentId: Number(student.rows[0].id),
    syncId: student.rows[0].sync_id as string,
    matric,
  };
  students[key] = fixture;
  myStudentSyncIds.add(fixture.syncId);
  return fixture;
}

async function makeSession(userId: number, key: string): Promise<void> {
  const token = `${PREFIX}-session-${key}`;
  await pool.query(
    `INSERT INTO sessions (user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hashSessionToken(token), new Date(Date.now() + 3_600_000)]
  );
  sessionTokens[userId] = token;
}

/**
 * Run the real enrollment ceremony and return the response body, including the
 * one-time `bootstrapSecret`. The plaintext is recorded here - the only place
 * outside the HTTP response it is ever seen - so the scans can look for it.
 */
async function enrollViaCeremony(
  userId: number
): Promise<{ status: number; bootstrapSecret?: string; deviceRef?: string }> {
  const optionsRes = await postJson(
    "/api/student/device/enrollment/options",
    {},
    cookieHeader(userId)
  );
  assert.equal(optionsRes.status, 200, "an active student must be able to start enrollment");
  const optionsBody = (await optionsRes.json()) as { data: { challenge: string } };

  const authenticator = await createTestAuthenticator();
  const credential = await buildRegistrationResponse({
    authenticator,
    challenge: optionsBody.data.challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
  });
  const res = await postJson(
    "/api/student/device/enrollment/complete",
    { credential },
    cookieHeader(userId)
  );
  if (res.status !== 201) {
    return { status: res.status };
  }
  const body = (await res.json()) as {
    credentialId: string;
    deviceRef: string;
    bootstrapSecret: string;
  };
  assert.equal(
    typeof body.bootstrapSecret,
    "string",
    "a committed enrollment must show its one-time secret"
  );
  assert.ok(body.bootstrapSecret.length > 0);
  issuedSecrets.push(body.bootstrapSecret);
  secretByStudent[userId] = body.bootstrapSecret;
  return {
    status: res.status,
    bootstrapSecret: body.bootstrapSecret,
    deviceRef: body.deviceRef,
  };
}

/** Give a student a local CLOUD-side device row directly, without a ceremony. */
async function seedLocalDevice(
  student: StudentFixture,
  options: { discoverable: boolean; suffix: string }
): Promise<{ id: number; deviceRef: string; credentialId: string }> {
  const credentialId = `${PREFIX}-cred-${options.suffix}`;
  const result = await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, cred_type,
        discoverable, status)
     VALUES ($1, $2, $3, 0, 'public-key', $4, 'ACTIVE')
     RETURNING id, device_ref, credential_id`,
    [student.studentId, credentialId, Buffer.from([0xa0, 0x01]), options.discoverable]
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    deviceRef: row.device_ref as string,
    credentialId: row.credential_id as string,
  };
}

/** Give a student an edge-side device projection row; returns its reference. */
async function seedDeviceProjection(
  student: StudentFixture,
  status: "ACTIVE" | "REVOKED" = "ACTIVE"
): Promise<string> {
  const deviceRef = randomUUID();
  await pool.query(
    `INSERT INTO sync_student_devices
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), deviceRef, student.studentId, student.syncId, status]
  );
  return deviceRef;
}

/**
 * Give a student a fully seeded binding fixture: an edge device projection and
 * a PENDING bootstrap row whose plaintext is generated right here.
 *
 * Used by the endpoint tests, whose subject is the spend statement. The hash
 * stored is `hashSessionToken(secret)`, exactly what the cloud stores for a
 * real mint - so the endpoint sees the same row shape it sees in production,
 * and every issued secret joins the final scan.
 *
 * Any projection rows the student already holds are cleared first: the
 * one-ACTIVE-device-per-student index means a second seed would otherwise
 * collide, and each test's fixture is meant to stand alone.
 */
async function seedBoundDevice(
  student: StudentFixture,
  options: {
    expiresInMs?: number;
    deviceStatus?: "ACTIVE" | "REVOKED";
  } = {}
): Promise<{ deviceRef: string; secret: string; bootstrapSyncId: string }> {
  await pool.query(
    `DELETE FROM sync_student_device_bootstraps WHERE student_id = $1`,
    [student.studentId]
  );
  await pool.query(`DELETE FROM sync_student_devices WHERE student_id = $1`, [
    student.studentId,
  ]);
  const secret = generateSessionToken();
  issuedSecrets.push(secret);
  const deviceRef = await seedDeviceProjection(
    student,
    options.deviceStatus ?? "ACTIVE"
  );
  const expiresAt = new Date(
    Date.now() + (options.expiresInMs ?? authConfig.deviceBootstrapLifetimeMs)
  );
  const result = await pool.query(
    `INSERT INTO sync_student_device_bootstraps
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
        secret_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
     RETURNING cloud_sync_id`,
    [
      randomUUID(),
      deviceRef,
      student.studentId,
      student.syncId,
      hashSessionToken(secret),
      expiresAt,
    ]
  );
  return {
    deviceRef,
    secret,
    bootstrapSyncId: result.rows[0].cloud_sync_id as string,
  };
}

async function localDeviceRows(studentId: number) {
  const result = await pool.query(
    `SELECT id, sync_id, device_ref, credential_id, status, discoverable
       FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [studentId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Feed helpers
// ---------------------------------------------------------------------------

/** Bootstrap events this file produced through the feed, oldest first. */
async function emittedBootstrapEvents(): Promise<SyncChangeEvent[]> {
  const batch = await listChangeEventsSince(feedFloor, 500);
  return batch.events.filter((event) => {
    if (event.entityType !== "student_device_bootstrap") return false;
    const payload = event.payload as SyncedStudentDeviceBootstrap;
    return myStudentSyncIds.has(payload.cloudStudentSyncId);
  });
}

async function bootstrapEventsFor(student: StudentFixture): Promise<SyncChangeEvent[]> {
  const all = await emittedBootstrapEvents();
  return all.filter(
    (event) =>
      (event.payload as SyncedStudentDeviceBootstrap).cloudStudentSyncId === student.syncId
  );
}

/** Device events this file produced, oldest first. */
async function emittedDeviceEvents(): Promise<SyncChangeEvent[]> {
  const batch = await listChangeEventsSince(feedFloor, 500);
  return batch.events.filter((event) => {
    if (event.entityType !== "student_device") return false;
    const payload = event.payload as SyncedStudentDevice;
    return myStudentSyncIds.has(payload.cloudStudentSyncId);
  });
}

async function deviceEventsFor(student: StudentFixture): Promise<SyncChangeEvent[]> {
  const all = await emittedDeviceEvents();
  return all.filter(
    (event) => (event.payload as SyncedStudentDevice).cloudStudentSyncId === student.syncId
  );
}

// ---------------------------------------------------------------------------
// Applier helpers (the in-memory consumer pattern from studentDeviceSync)
// ---------------------------------------------------------------------------

async function freshConsumer(suffix: string): Promise<string> {
  const consumerId = `${CONSUMER_PREFIX}${suffix}`;
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [consumerId]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id = $1`, [consumerId]);
  await readCursor(consumerId);
  return consumerId;
}

/**
 * Empty the applier's student of projection state, the way `freshConsumer`
 * empties its cursor. The one-ACTIVE-device-per-student index means a row left
 * by the previous test would collide with the next test's seed, so every
 * applier test starts from no devices and no bootstraps.
 */
async function resetApplierState(): Promise<void> {
  await pool.query(`DELETE FROM sync_student_device_bootstraps WHERE student_id = $1`, [
    students.applier.studentId,
  ]);
  await pool.query(`DELETE FROM sync_student_devices WHERE student_id = $1`, [
    students.applier.studentId,
  ]);
}

function bootstrapPayload(
  overrides: Partial<SyncedStudentDeviceBootstrap> = {}
): SyncedStudentDeviceBootstrap {
  return {
    version: SYNC_PAYLOAD_VERSION,
    syncId: randomUUID(),
    cloudDeviceRef: randomUUID(),
    cloudStudentSyncId: students.applier.syncId,
    secretHash: hashSessionToken(generateSessionToken()),
    status: "PENDING",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function bootstrapEvent(input: {
  cursor: number;
  operation?: SyncOperation;
  payload: SyncedStudentDeviceBootstrap;
  eventId?: string;
  entityType?: SyncEntityType;
}): SyncChangeEvent {
  return {
    eventId: input.eventId ?? randomUUID(),
    cursor: input.cursor,
    entityType: input.entityType ?? "student_device_bootstrap",
    entityId: input.payload.syncId,
    operation: input.operation ?? "CREATED",
    payload: input.payload as SyncChangeEvent["payload"],
    recordedAt: new Date().toISOString(),
  };
}

async function replicaBootstrapRow(cloudSyncId: string) {
  const result = await pool.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id,
            cloud_student_sync_id, secret_hash, status, expires_at, consumed_at
       FROM sync_student_device_bootstraps WHERE cloud_sync_id = $1`,
    [cloudSyncId]
  );
  return result.rows[0] ?? null;
}

async function cursorOf(consumerId: string): Promise<number> {
  return readCursor(consumerId);
}

async function receiptCount(consumerId: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM sync_processed_events WHERE consumer_id = $1`,
    [consumerId]
  );
  return result.rows[0].n as number;
}

/** The cloud-side bootstrap row of a ceremony student, with its device ref. */
async function cloudBootstrapRows(studentId: number) {
  const result = await pool.query(
    `SELECT b.sync_id, b.secret_hash, b.status, b.expires_at, d.device_ref
       FROM student_device_bootstraps b
       JOIN student_devices d ON d.id = b.device_id
      WHERE b.student_id = $1`,
    [studentId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

before(async () => {
  await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2)`,
    [`${PREFIX} Faculty`, `${PREFIX}FAC`]
  );
  facultyId = Number(
    (await pool.query(`SELECT id FROM faculties WHERE code = $1`, [`${PREFIX}FAC`])).rows[0].id
  );

  await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3)`,
    [`${PREFIX} Department`, `${PREFIX}DEPT`, facultyId]
  );
  departmentId = Number(
    (await pool.query(`SELECT id FROM departments WHERE code = $1`, [`${PREFIX}DEPT`])).rows[0].id
  );

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelId = Number(level.rows[0].id);

  // One student per scenario, so no test can disturb another's secret.
  await makeStudent("emit", "A"); // ceremony emission
  await makeStudent("emitUpgrade", "B"); // upgrade emission
  await makeStudent("bind", "C"); // happy-path spend + follow-up login
  await makeStudent("badSecret", "D"); // wrong secret / unknown matric
  await makeStudent("badPassword", "E"); // wrong password
  await makeStudent("noMatch", "F"); // secret whose projection never synced
  await makeStudent("expired", "G"); // expired secret
  await makeStudent("revokedDevice", "H"); // secret for a revoked device
  await makeStudent("inactive", "I"); // secret for an inactive account
  await makeStudent("applier", "J"); // the applier's student

  for (const key of ["emit", "emitUpgrade", "bind", "badSecret", "badPassword", "noMatch"]) {
    await makeSession(students[key].userId, key);
  }

  // Consumers from an earlier run would start at a stale cursor, so this file's
  // consumers are rebuilt every run.
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);

  const max = await pool.query(
    `SELECT coalesce(max(cursor), 0)::bigint AS m FROM sync_change_events`
  );
  feedFloor = Number(max.rows[0].m);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  const studentIds = Object.values(students).map((s) => s.studentId);
  const userIds = Object.values(students).map((s) => s.userId);
  const deviceIds = (
    await pool.query(`SELECT id FROM student_devices WHERE student_id = ANY($1::BIGINT[])`, [
      studentIds,
    ])
  ).rows.map((row: { id: unknown }) => Number(row.id));

  await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(
    `DELETE FROM audit_logs
      WHERE user_id = ANY($1::BIGINT[])
         OR entity_id = ANY($1::BIGINT[])
         OR (entity_type = 'student_devices' AND entity_id = ANY($2::BIGINT[]))`,
    [userIds, deviceIds]
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_challenges WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(
    `DELETE FROM student_device_enrollment_grants WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(
    `DELETE FROM sync_change_events
      WHERE entity_type IN ('student_device', 'student_device_bootstrap')
        AND payload->'entity'->>'cloudStudentSyncId' = ANY($1::TEXT[])`,
    [[...myStudentSyncIds]]
  );
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  // RESTRICT/dependent rows before their parents: bootstraps and projections
  // reference students, and the cloud's bootstraps reference both students and
  // device rows.
  await pool.query(
    `DELETE FROM sync_student_device_bootstraps WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(`DELETE FROM sync_student_devices WHERE student_id = ANY($1::BIGINT[])`, [
    studentIds,
  ]);
  await pool.query(
    `DELETE FROM student_device_bootstraps WHERE student_id = ANY($1::BIGINT[])`,
    [studentIds]
  );
  await pool.query(`DELETE FROM student_devices WHERE student_id = ANY($1::BIGINT[])`, [
    studentIds,
  ]);
  await pool.query(`DELETE FROM students WHERE id = ANY($1::BIGINT[])`, [studentIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  await pool.query(`DELETE FROM departments WHERE code = $1`, [`${PREFIX}DEPT`]);
  await pool.query(`DELETE FROM faculties WHERE code = $1`, [`${PREFIX}FAC`]);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

test("1. a committed enrollment emits exactly one bootstrap event carrying the shown secret's hash", async () => {
  const student = students.emit;
  const enrolled = await enrollViaCeremony(student.userId);
  assert.equal(enrolled.status, 201, "the ceremony must commit");
  const secret = enrolled.bootstrapSecret!;

  const events = await bootstrapEventsFor(student);
  assert.equal(events.length, 1, "one event per minted secret");
  assert.equal(events[0].entityType, "student_device_bootstrap");
  assert.equal(events[0].operation, "CREATED");

  // Ordering the edge depends on: the device has to exist in the projection
  // before the secret that binds to it.
  const deviceEvents = await deviceEventsFor(student);
  assert.equal(deviceEvents.length, 1, "the ceremony publishes its device too");
  assert.ok(
    deviceEvents[0].cursor < events[0].cursor,
    "the bootstrap must be published after its device"
  );

  const payload = events[0].payload as SyncedStudentDeviceBootstrap;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ALLOWED_PAYLOAD_KEYS,
    "the payload must carry identity, parent, hash, status and expiry - nothing else"
  );
  assert.equal(payload.version, SYNC_PAYLOAD_VERSION);
  assert.equal(payload.syncId, events[0].entityId, "the event is addressed by the bootstrap sync_id");
  assert.equal(payload.cloudStudentSyncId, student.syncId, "the parent crosses by UUID");
  assert.equal(payload.status, "PENDING", "the cloud only ever mints unspent secrets");
  assert.match(payload.syncId, UUID_PATTERN);
  assert.match(payload.cloudDeviceRef, UUID_PATTERN);
  assert.match(payload.cloudStudentSyncId, UUID_PATTERN);

  // The hash identity, end to end: the plaintext in the response hashes to the
  // value in the payload, which is the value in the row.
  const expectedHash = hashSessionToken(secret);
  assert.equal(payload.secretHash, expectedHash, "the published hash is the shown secret's hash");
  const row = (
    await pool.query(
      `SELECT b.secret_hash, b.status, b.expires_at, b.student_id, d.device_ref
         FROM student_device_bootstraps b
         JOIN student_devices d ON d.id = b.device_id
        WHERE b.sync_id = $1`,
      [payload.syncId]
    )
  ).rows[0];
  assert.ok(row, "the minted secret must be stored");
  assert.equal(row.secret_hash, expectedHash, "only this hash is stored");
  assert.equal(row.status, "PENDING");
  assert.equal(row.device_ref, payload.cloudDeviceRef, "the secret binds to this device");
  assert.equal(
    Number(row.student_id),
    student.studentId,
    "the secret binds to this student"
  );
  assert.notEqual(row.secret_hash, secret, "the stored value is never the plaintext");

  // Expiry: minted now, with the configured lifetime, on the database clock.
  const expiresAt = Date.parse(payload.expiresAt);
  assert.equal(new Date(row.expires_at).getTime(), expiresAt, "row and payload agree on expiry");
  const drift = Math.abs(expiresAt - (Date.now() + authConfig.deviceBootstrapLifetimeMs));
  assert.ok(drift < 120_000, `expiresAt must be now + lifetime (drifted ${drift}ms)`);
});

test("2. the secret's plaintext exists nowhere in the stored row or the published feed", async () => {
  const student = students.emit;
  const secret = secretByStudent[student.userId];
  assert.ok(secret, "the ceremony must have shown a secret");

  const events = await bootstrapEventsFor(student);
  assert.equal(events.length, 1);
  const eventJson = JSON.stringify(events);
  assert.ok(
    !eventJson.includes(secret),
    "the plaintext secret must never appear in a feed event"
  );

  const rows = await cloudBootstrapRows(student.studentId);
  assert.equal(rows.length, 1);
  const rowJson = JSON.stringify(rows);
  assert.ok(!rowJson.includes(secret), "the plaintext secret must never be stored");

  // And a scan of every column, not just the ones the query named.
  const raw = await pool.query(
    `SELECT b.* FROM student_device_bootstraps b WHERE b.student_id = $1`,
    [student.studentId]
  );
  assert.ok(
    !JSON.stringify(raw.rows).includes(secret),
    "no column of the stored row may hold the plaintext"
  );
});

test("3. an upgrade mints a bootstrap only for the new device", async () => {
  const student = students.emitUpgrade;
  const legacy = await seedLocalDevice(student, {
    discoverable: false,
    suffix: "upgrade-legacy",
  });

  const enrolled = await enrollViaCeremony(student.userId);
  assert.equal(enrolled.status, 201, "a non-discoverable device must be upgradable");

  const events = await bootstrapEventsFor(student);
  assert.equal(events.length, 1, "exactly one secret is minted per enrollment");
  const payload = events[0].payload as SyncedStudentDeviceBootstrap;

  const rows = await localDeviceRows(student.studentId);
  const active = rows.filter((r) => r.status === "ACTIVE");
  assert.equal(active.length, 1);
  assert.equal(
    payload.cloudDeviceRef,
    active[0].device_ref,
    "the secret binds to the device the ceremony just created"
  );
  assert.notEqual(
    payload.cloudDeviceRef,
    legacy.deviceRef,
    "the replaced device gets no new secret"
  );
  assert.equal(payload.status, "PENDING");
  assert.equal(payload.cloudStudentSyncId, student.syncId);
});

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

test("4. the edge applies a bootstrap into the projection", async () => {
  const consumerId = await freshConsumer("apply");
  await resetApplierState();
  const deviceRef = await seedDeviceProjection(students.applier);
  const payload = bootstrapPayload({ cloudDeviceRef: deviceRef });

  const result = await applyChangeBatch(consumerId, [
    bootstrapEvent({ cursor: 1, payload }),
  ]);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, 1);

  const row = await replicaBootstrapRow(payload.syncId);
  assert.ok(row, "the bootstrap must exist in the projection");
  assert.equal(row.cloud_device_ref, deviceRef);
  assert.equal(row.cloud_student_sync_id, payload.cloudStudentSyncId);
  assert.equal(row.secret_hash, payload.secretHash, "the hash crosses unchanged");
  assert.equal(row.status, "PENDING");
  assert.equal(
    Number(row.student_id),
    students.applier.studentId,
    "the parent UUID resolved to the local student row"
  );
  assert.equal(
    new Date(row.expires_at).getTime(),
    Date.parse(payload.expiresAt),
    "the expiry crosses unchanged"
  );
  assert.equal(row.consumed_at, null, "an applied secret is unspent");
  assert.equal(await receiptCount(consumerId), 1);
});

test("5. a re-delivered PENDING event cannot resurrect a consumed secret", async () => {
  const consumerId = await freshConsumer("replay-consumed");
  await resetApplierState();
  const deviceRef = await seedDeviceProjection(students.applier);
  const payload = bootstrapPayload({ cloudDeviceRef: deviceRef });

  const first = await applyChangeBatch(consumerId, [
    bootstrapEvent({ cursor: 1, payload }),
  ]);
  assert.equal(first.applied, 1);

  // The student spent it on this edge. The cloud is never told - sync is one
  // direction - so every event it can ever re-deliver still says PENDING.
  await pool.query(
    `UPDATE sync_student_device_bootstraps
        SET status = 'CONSUMED', consumed_at = now()
      WHERE cloud_sync_id = $1`,
    [payload.syncId]
  );
  const spent = await replicaBootstrapRow(payload.syncId);
  assert.equal(spent.status, "CONSUMED");

  const replay = await applyChangeBatch(consumerId, [
    bootstrapEvent({ cursor: 2, operation: "UPDATED", payload }),
  ]);
  assert.equal(replay.applied, 1, "the upsert absorbs the replay");

  const after = await replicaBootstrapRow(payload.syncId);
  assert.equal(after.status, "CONSUMED", "a spent secret must stay spent");
  assert.equal(
    new Date(after.consumed_at).getTime(),
    new Date(spent.consumed_at).getTime(),
    "the spend timestamp must be untouched by the replay"
  );
  assert.equal(await cursorOf(consumerId), 2);
});

test("6. a bootstrap whose device has not synchronized fails safely", async () => {
  const consumerId = await freshConsumer("missing-device");
  await resetApplierState();
  const payload = bootstrapPayload({ cloudDeviceRef: randomUUID() });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [bootstrapEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      assert.match((error as Error).message, /device/);
      return true;
    }
  );

  assert.equal(
    await replicaBootstrapRow(payload.syncId),
    null,
    "a secret bound to an unknown device must not be stored"
  );
  assert.equal(await cursorOf(consumerId), 0, "a failure must not advance the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a failure must not be acknowledged");
});

test("7. a bootstrap whose student has not synchronized fails safely", async () => {
  const consumerId = await freshConsumer("missing-student");
  await resetApplierState();
  const payload = bootstrapPayload({ cloudStudentSyncId: randomUUID() });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [bootstrapEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      return true;
    }
  );

  assert.equal(await replicaBootstrapRow(payload.syncId), null);
  assert.equal(await cursorOf(consumerId), 0, "a failure must not advance the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a failure must not be acknowledged");
});

test("8. a bootstrap whose device belongs to another student is refused", async () => {
  const consumerId = await freshConsumer("wrong-owner");
  await resetApplierState();
  // The device really exists - but it belongs to the applier's student, while
  // the event claims the emit student's secret. The consume statement joins
  // device to student, so this secret could never be spent; storing it would
  // leave a row that looks spendable to a reader.
  const deviceRef = await seedDeviceProjection(students.applier);
  const payload = bootstrapPayload({
    cloudDeviceRef: deviceRef,
    cloudStudentSyncId: students.emit.syncId,
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [bootstrapEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /different student/);
      return true;
    }
  );

  assert.equal(await replicaBootstrapRow(payload.syncId), null);
  assert.equal(await cursorOf(consumerId), 0, "a refusal must hold the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a refusal must not be acknowledged");
});

test("9. a sync_id and device reference held by different rows is refused", async () => {
  const consumerId = await freshConsumer("ambiguous");
  await resetApplierState();
  const deviceRef = await seedDeviceProjection(students.applier);
  const rowX = { syncId: randomUUID(), deviceRef: randomUUID() };
  const rowY = { syncId: randomUUID(), deviceRef };
  for (const seed of [rowX, rowY]) {
    await pool.query(
      `INSERT INTO sync_student_device_bootstraps
         (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
          secret_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', now() + interval '1 hour')`,
      [
        seed.syncId,
        seed.deviceRef,
        students.applier.studentId,
        students.applier.syncId,
        hashSessionToken(generateSessionToken()),
      ]
    );
  }

  // Row X's identity with row Y's device reference: two different local rows
  // could both be "the" bootstrap in this event, and the choice is a human's.
  const payload = bootstrapPayload({
    syncId: rowX.syncId,
    cloudDeviceRef: rowY.deviceRef,
  });
  await assert.rejects(
    () => applyChangeBatch(consumerId, [bootstrapEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /Refusing to guess/);
      return true;
    }
  );

  assert.equal(await cursorOf(consumerId), 0, "a refusal must hold the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a refusal must not be acknowledged");
  const x = await replicaBootstrapRow(rowX.syncId);
  const y = await replicaBootstrapRow(rowY.syncId);
  assert.equal(x.cloud_device_ref, rowX.deviceRef, "row X keeps its own identity");
  assert.equal(y.cloud_device_ref, rowY.deviceRef, "row Y keeps its own identity");
  assert.equal(x.status, "PENDING");
  assert.equal(y.status, "PENDING");
});

test("10. an unsupported bootstrap status fails the batch", async () => {
  const consumerId = await freshConsumer("bad-status");
  await resetApplierState();
  const deviceRef = await seedDeviceProjection(students.applier);
  const payload = bootstrapPayload({
    cloudDeviceRef: deviceRef,
    // A value the `sync_student_device_bootstraps` CHECK constraint does not admit.
    status: "EXPIRED" as SyncedStudentDeviceBootstrap["status"],
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [bootstrapEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /unsupported status/);
      return true;
    }
  );

  assert.equal(await replicaBootstrapRow(payload.syncId), null);
  assert.equal(await cursorOf(consumerId), 0, "the cursor must not advance");
  assert.equal(await receiptCount(consumerId), 0, "the event must not be acknowledged");
});

// ---------------------------------------------------------------------------
// Spending the secret (the endpoint)
// ---------------------------------------------------------------------------

const BOOTSTRAP_PATH = "/api/auth/student/device/bootstrap";

test("11. a valid secret binds the device and spends itself", async () => {
  const student = students.bind;
  const seeded = await seedBoundDevice(student);

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(res.status, 200, "the three proofs must all hold");
  assert.deepEqual(await res.json(), { deviceBound: true });

  const setCookies = res.headers.getSetCookie();
  const binding = cookieValue(setCookies, authConfig.deviceBindingCookieName);
  assert.equal(binding, seeded.deviceRef, "the cookie carries the device reference");
  assert.ok(
    !setCookies.some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    "a bootstrap must never mint a session - it proves a secret, not a sign-in"
  );

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "CONSUMED", "the secret must be spent");
  assert.ok(row.consumed_at, "the spend must be timestamped");

  // The binding must be exactly as usable as a locally enrolled one.
  const check = await get("/api/auth/student/device-binding", {
    cookie: `${authConfig.deviceBindingCookieName}=${seeded.deviceRef}`,
  });
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), {
    hasDeviceBinding: true,
    matricNumber: student.matric,
  });

  bindDeviceRef = seeded.deviceRef;
});

test("12. a follow-up login with the new binding needs only the password", async () => {
  const student = students.bind;
  assert.ok(bindDeviceRef, "the previous test must have bound a device");

  assert.equal(
    (await localDeviceRows(student.studentId)).length,
    0,
    "this student holds no local credential - the binding came from the projection"
  );

  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: student.matric, password: TEST_PASSWORD },
    { cookie: `${authConfig.deviceBindingCookieName}=${bindDeviceRef}` }
  );
  assert.equal(res.status, 200, "the bound browser signs in without a ceremony");
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(body.user.matricNumber, student.matric);
  assert.ok(
    res.headers.getSetCookie().some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    "a bound login mints the normal session"
  );
});

test("13. a spent secret cannot be spent again", async () => {
  const student = students.bind;
  const seeded = await seedBoundDevice(student);

  const first = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(first.status, 200);

  const second = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(second.status, 401, "the second presentation must be refused");
  assert.deepEqual(await second.json(), { error: "INVALID_CREDENTIALS" });
  assert.ok(
    !second.headers
      .getSetCookie()
      .some((c) => c.startsWith(`${authConfig.deviceBindingCookieName}=`)),
    "a refused replay must not re-issue the binding"
  );

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "CONSUMED");
});

test("14. a wrong secret is the same failure as a wrong password", async () => {
  const student = students.badSecret;
  const seeded = await seedBoundDevice(student);

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    // A syntactically perfect secret that was never minted for anyone.
    secret: generateSessionToken(),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(
    await res.json(),
    { error: "INVALID_CREDENTIALS" },
    "a wrong secret must be indistinguishable from a wrong password"
  );
  assert.ok(!res.headers.getSetCookie().length, "no cookie of any kind may be set");

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING", "a failed guess must not spend the secret");
  assert.equal(row.consumed_at, null);
});

test("15. a wrong password leaves the secret unspent", async () => {
  const student = students.badPassword;
  const seeded = await seedBoundDevice(student);

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: "definitely-not-the-password",
    secret: seeded.secret,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING", "possession of the secret alone must not bind anything");
  assert.equal(row.consumed_at, null);
});

test("16. an unknown matric number changes nothing", async () => {
  const student = students.badSecret;
  const seeded = await seedBoundDevice(student);

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: `${PREFIX}/GHOST`,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING", "a secret can never be spent by another identity");
});

test("17. a missing secret or password is a 400", async () => {
  const student = students.badSecret;

  const noSecret = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
  });
  assert.equal(noSecret.status, 400);
  assert.deepEqual(await noSecret.json(), {
    error: "INVALID_REQUEST",
    message: "A valid matric number, password and secret are required.",
  });

  const noPassword = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    secret: generateSessionToken(),
  });
  assert.equal(noPassword.status, 400);
  assert.deepEqual(await noPassword.json(), {
    error: "INVALID_REQUEST",
    message: "A valid matric number, password and secret are required.",
  });

  const garbage = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: "not a base64url secret!",
  });
  assert.equal(garbage.status, 400, "an unmintable secret is refused before any lookup");
});

test("18. an expired secret is refused and stays unspent", async () => {
  const student = students.expired;
  const seeded = await seedBoundDevice(student, { expiresInMs: -60_000 });

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING", "expiry must not be confused with consumption");
  assert.equal(row.consumed_at, null);
});

test("19. a revoked device's secret is refused and stays unspent", async () => {
  const student = students.revokedDevice;
  const seeded = await seedBoundDevice(student, { deviceStatus: "REVOKED" });

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(res.status, 401, "a revoked device must not be re-bindable by any secret");
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING", "a revoked device's secret is refused, never spent");
});

test("20. an inactive student's secret is refused", async () => {
  const student = students.inactive;
  const seeded = await seedBoundDevice(student);
  await pool.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [student.userId]);

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: seeded.secret,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const row = await replicaBootstrapRow(seeded.bootstrapSyncId);
  assert.equal(row.status, "PENDING");
  assert.equal(row.consumed_at, null);
});

test("21. a secret whose projection never synchronized is refused", async () => {
  const student = students.noMatch;
  const enrolled = await enrollViaCeremony(student.userId);
  assert.equal(enrolled.status, 201);

  // The cloud minted and stored its half (a cloud row plus the feed event),
  // but the edge never applied either projection - the exact state a fresh or
  // lagging edge is in. There is nothing here to spend.
  const cloudRows = await cloudBootstrapRows(student.studentId);
  assert.equal(cloudRows.length, 1, "the cloud's half exists");

  const res = await postJson(BOOTSTRAP_PATH, {
    matricNumber: student.matric,
    password: TEST_PASSWORD,
    secret: enrolled.bootstrapSecret!,
  });
  assert.equal(res.status, 401, "a secret the edge has never seen must not bind anything");
  assert.deepEqual(await res.json(), { error: "INVALID_CREDENTIALS" });

  const edgeRows = await pool.query(
    `SELECT 1 FROM sync_student_device_bootstraps WHERE student_id = $1`,
    [student.studentId]
  );
  assert.equal(edgeRows.rowCount, 0, "nothing may be written from a refused bootstrap");
});

test("22. no bootstrap event or stored row anywhere carries a plaintext secret", async () => {
  // Runs last, so the scan covers every ceremony and every seeded fixture above.
  const events = await emittedBootstrapEvents();
  assert.ok(
    events.length >= 3,
    `expected every ceremony to publish (emit, emitUpgrade, noMatch), saw ${events.length}`
  );
  assert.ok(issuedSecrets.length >= 6, "expected every fixture to issue a secret");

  for (const event of events) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const key of FORBIDDEN_PAYLOAD_SUBSTRINGS) {
      assert.ok(
        !serialised.includes(key),
        `bootstrap payload must not contain "${key}"`
      );
    }
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ALLOWED_PAYLOAD_KEYS,
      "every bootstrap payload carries only identity, parent, hash, status and expiry"
    );
  }

  const eventJson = JSON.stringify(events);
  for (const secret of issuedSecrets) {
    assert.ok(
      !eventJson.includes(secret),
      "a plaintext secret must never enter the feed"
    );
  }

  // Stored rows on both sides of the boundary.
  const cloudRows = await pool.query(
    `SELECT b.* FROM student_device_bootstraps b
       JOIN students s ON s.id = b.student_id
      WHERE s.matric_number LIKE $1`,
    [`${PREFIX}/%`]
  );
  const edgeRows = await pool.query(
    `SELECT b.* FROM sync_student_device_bootstraps b
       JOIN students s ON s.id = b.student_id
      WHERE s.matric_number LIKE $1`,
    [`${PREFIX}/%`]
  );
  const cloudJson = JSON.stringify(cloudRows.rows);
  const edgeJson = JSON.stringify(edgeRows.rows);
  for (const secret of issuedSecrets) {
    assert.ok(!cloudJson.includes(secret), "no cloud column may hold a plaintext secret");
    assert.ok(!edgeJson.includes(secret), "no edge column may hold a plaintext secret");
  }
});
