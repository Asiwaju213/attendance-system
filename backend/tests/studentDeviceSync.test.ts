// Task: cloud -> edge device-state synchronization (the `student_device` entity).
//
// The device question this feature answers is narrow and worth stating before
// the tests: an edge needs to know whether a browser presenting a
// device-binding cookie still holds an ACTIVE binding for one of its students.
// That decision needs an opaque device reference, a student reference and a
// status - and nothing credential-shaped. So the tests come in three groups:
//
// - Emission: enrolling, upgrading and resetting a device writes its change
//   event on the SAME client, before the same COMMIT, with a payload that is
//   identity, parent and status and nothing else. The absence of credential
//   material is asserted field by field, because "the emitter never selects
//   the credential columns" is a property of the payload, not a comment.
//
// - Application: the edge writes device state into its `sync_student_devices`
//   projection (never into `student_devices`, whose rows are locally enrolled
//   credentials), resolves the student by cloud UUID without ever creating
//   one, stays idempotent under replay, adopts an identity onto a row it
//   already holds, and refuses rather than guessing when two rows could be the
//   device in the event or when a second device would go ACTIVE.
//
// - Login stays local: a password login resolves the binding cookie against
//   local device rows first and the projection second, and mints a session
//   from the binding PLUS the password - the WebAuthn ceremony, the credential
//   id and the public key are never involved in either path.
//
// The applier tests build their events in memory with a dedicated consumer,
// the same way courseRegistrationSync.test.ts exercises its applier.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { SYNC_PAYLOAD_VERSION } from "../src/config/sync";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { hashSessionToken } from "../src/lib/sessions";
import { resetStudentRegistration } from "../src/services/adminStudentStore";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { SyncApplyError } from "../src/services/syncErrors";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncOperation,
  SyncedStudentDevice,
} from "../src/types/sync";
import {
  buildRegistrationResponse,
  createTestAuthenticator,
} from "./webauthnTestHelpers";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const PREFIX = `DEVSYNC${Date.now().toString(36).toUpperCase()}`;
const CONSUMER_PREFIX = `${PREFIX}-`;
const TEST_PASSWORD = "device-sync-test-password";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every field the device payload is allowed to carry. */
const ALLOWED_PAYLOAD_KEYS = [
  "cloudDeviceRef",
  "cloudStudentSyncId",
  "status",
  "syncId",
  "version",
].sort();

/** Credential material that must never appear anywhere in a device payload. */
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
  "secret",
  "matric",
];

let server: Server;
let baseUrl: string;
let facultyId = 0;
let departmentId = 0;
let levelId = 0;
let adminUserId = 0;
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

const adminCookie = () => cookieHeader(adminUserId);

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

async function studentIdOf(userId: number): Promise<number> {
  const result = await pool.query(
    `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return Number(result.rows[0].id);
}

/**
 * Give a student an ACTIVE device row directly, without a ceremony.
 *
 * Used by the reset and login tests, whose subject is what happens to device
 * STATE, not how the credential was created. The credential id is unique per
 * run and the stored key is a placeholder never used for a signature.
 */
async function seedActiveDevice(
  student: StudentFixture,
  options: { discoverable: boolean; suffix: string }
): Promise<{ id: number; syncId: string; deviceRef: string; credentialId: string }> {
  const credentialId = `${PREFIX}-cred-${options.suffix}`;
  const result = await pool.query(
    `INSERT INTO student_devices
       (student_id, credential_id, credential_public_key, counter, cred_type,
        discoverable, status)
     VALUES ($1, $2, $3, 0, 'public-key', $4, 'ACTIVE')
     RETURNING id, sync_id, device_ref, credential_id`,
    [student.studentId, credentialId, Buffer.from([0xa0, 0x01]), options.discoverable]
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    syncId: row.sync_id as string,
    deviceRef: row.device_ref as string,
    credentialId: row.credential_id as string,
  };
}

/** Run the real enrollment ceremony and return the stored device identities. */
async function enrollViaCeremony(
  userId: number,
  options: { badOrigin?: boolean } = {}
): Promise<{ status: number; credentialId?: string; deviceRef?: string }> {
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
    origin: options.badOrigin ? "https://evil.example.com" : webauthnConfig.expectedOrigin,
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
  const body = (await res.json()) as { credentialId: string; deviceRef: string };
  return { status: res.status, credentialId: body.credentialId, deviceRef: body.deviceRef };
}

async function deviceRows(studentId: number) {
  const result = await pool.query(
    `SELECT id, sync_id, device_ref, credential_id, status, discoverable
       FROM student_devices WHERE student_id = $1 ORDER BY id`,
    [studentId]
  );
  return result.rows;
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

async function eventsFor(student: StudentFixture): Promise<SyncChangeEvent[]> {
  const all = await emittedDeviceEvents();
  return all.filter(
    (event) => (event.payload as SyncedStudentDevice).cloudStudentSyncId === student.syncId
  );
}

// ---------------------------------------------------------------------------
// Applier helpers (the in-memory consumer pattern from courseRegistrationSync)
// ---------------------------------------------------------------------------

async function freshConsumer(suffix: string): Promise<string> {
  const consumerId = `${CONSUMER_PREFIX}${suffix}`;
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [consumerId]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id = $1`, [consumerId]);
  await readCursor(consumerId);
  return consumerId;
}

function devicePayload(
  overrides: Partial<SyncedStudentDevice> = {}
): SyncedStudentDevice {
  return {
    version: SYNC_PAYLOAD_VERSION,
    syncId: randomUUID(),
    cloudDeviceRef: randomUUID(),
    cloudStudentSyncId: students.one.syncId,
    status: "ACTIVE",
    ...overrides,
  };
}

function deviceEvent(input: {
  cursor: number;
  operation?: SyncOperation;
  payload: SyncedStudentDevice;
  eventId?: string;
  entityType?: SyncEntityType;
}): SyncChangeEvent {
  return {
    eventId: input.eventId ?? randomUUID(),
    cursor: input.cursor,
    entityType: input.entityType ?? "student_device",
    entityId: input.payload.syncId,
    operation: input.operation ?? "CREATED",
    payload: input.payload as SyncChangeEvent["payload"],
    recordedAt: new Date().toISOString(),
  };
}

async function replicaRows(studentId: number) {
  const result = await pool.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id,
            cloud_student_sync_id, status
       FROM sync_student_devices WHERE student_id = $1 ORDER BY cloud_sync_id`,
    [studentId]
  );
  return result.rows;
}

async function replicaByDeviceRef(deviceRef: string) {
  const result = await pool.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id,
            cloud_student_sync_id, status
       FROM sync_student_devices WHERE cloud_device_ref = $1`,
    [deviceRef]
  );
  return result.rows[0] ?? null;
}

async function cursorOf(consumerId: string): Promise<number> {
  return readCursor(consumerId);
}

/**
 * Give `students.one` an empty projection, the way `freshConsumer` gives it an
 * empty cursor.
 *
 * The applier tests each build their own device, but they share one student -
 * and one student may hold one ACTIVE device, so a row left ACTIVE by the
 * previous test would make the next test's seed event fail the very invariant
 * under test. Every applier test therefore starts from no replica rows.
 */
async function resetReplica(): Promise<void> {
  await pool.query(`DELETE FROM sync_student_devices WHERE student_id = $1`, [
    students.one.studentId,
  ]);
}

async function receiptCount(consumerId: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM sync_processed_events WHERE consumer_id = $1`,
    [consumerId]
  );
  return result.rows[0].n as number;
}

async function clearGrantsFor(studentId: number): Promise<void> {
  await pool.query(
    `DELETE FROM student_device_enrollment_grants WHERE student_id = $1`,
    [studentId]
  );
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

  const admin = await pool.query(
    `INSERT INTO users (name, username, password_hash, role, status)
     VALUES ($1, $2, NULL, 'ADMIN', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Admin`, `${PREFIX}_ADMIN`]
  );
  adminUserId = Number(admin.rows[0].id);

  // One student per scenario, so no test can disturb another's device state.
  await makeStudent("enroll", "A"); // ceremony emission + device-ref login
  await makeStudent("upgrade", "B"); // revocation-before-creation ordering
  await makeStudent("deviceReset", "C"); // admin device reset emission
  await makeStudent("one", "D"); // the applier's student
  await makeStudent("regReset", "E"); // registration reset that revokes
  await makeStudent("regResetNoDevice", "F"); // registration reset that does not
  await makeStudent("rollback", "G"); // rolled-back reset
  await makeStudent("replicaLogin", "H"); // replica-resolved login

  const adminToken = `${PREFIX}-admin-session`;
  await pool.query(
    `INSERT INTO sessions (user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [adminUserId, hashSessionToken(adminToken), new Date(Date.now() + 3_600_000)]
  );
  sessionTokens[adminUserId] = adminToken;

  for (const key of ["enroll", "upgrade"]) {
    const token = `${PREFIX}-session-${key}`;
    await pool.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [students[key].userId, hashSessionToken(token), new Date(Date.now() + 3_600_000)]
    );
    sessionTokens[students[key].userId] = token;
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
  const userIds = Object.values(students).map((s) => s.userId).concat(adminUserId);
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
  for (const studentId of studentIds) {
    await clearGrantsFor(studentId);
  }
  await pool.query(
    `DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`,
    [userIds]
  );
  await pool.query(
    `DELETE FROM sync_change_events
      WHERE entity_type = 'student_device'
        AND payload->'entity'->>'cloudStudentSyncId' = ANY($1::TEXT[])`,
    [[...myStudentSyncIds]]
  );
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_student_devices WHERE student_id = ANY($1::BIGINT[])`, [
    studentIds,
  ]);
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

test("1. a committed enrollment emits exactly one CREATED student_device event", async () => {
  const student = students.enroll;
  const enrolled = await enrollViaCeremony(student.userId);
  assert.equal(enrolled.status, 201, "the ceremony must commit");

  const events = await eventsFor(student);
  assert.equal(events.length, 1, "one event per newly created device");
  assert.equal(events[0].entityType, "student_device");
  assert.equal(events[0].operation, "CREATED");

  const rows = await deviceRows(student.studentId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(events[0].entityId, row.sync_id, "the event is addressed by the device sync_id");

  const payload = events[0].payload as SyncedStudentDevice;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ALLOWED_PAYLOAD_KEYS,
    "the payload must carry only identity, parent and status"
  );
  assert.equal(payload.version, SYNC_PAYLOAD_VERSION);
  assert.equal(payload.syncId, row.sync_id);
  assert.equal(payload.cloudDeviceRef, row.device_ref, "the device reference crosses");
  assert.equal(payload.cloudStudentSyncId, student.syncId, "the parent crosses by UUID");
  assert.equal(payload.status, "ACTIVE");
  assert.match(payload.syncId, UUID_PATTERN);
  assert.match(payload.cloudDeviceRef, UUID_PATTERN);
  assert.match(payload.cloudStudentSyncId, UUID_PATTERN);
  assert.notEqual(
    payload.cloudDeviceRef,
    enrolled.credentialId,
    "the device reference is not the credential id"
  );
});

test("2. an upgrade publishes the revocation before the replacement", async () => {
  const student = students.upgrade;
  const legacy = await seedActiveDevice(student, {
    discoverable: false,
    suffix: "upgrade-legacy",
  });

  const enrolled = await enrollViaCeremony(student.userId);
  assert.equal(enrolled.status, 201, "a non-discoverable device must be upgradable");

  const events = await eventsFor(student);
  assert.equal(events.length, 2, "the replacement publishes both halves");
  assert.ok(
    events[0].cursor < events[1].cursor,
    "the events must be published in the order the edge has to apply them"
  );

  const [revocation, creation] = events;
  const oldPayload = revocation.payload as SyncedStudentDevice;
  const newPayload = creation.payload as SyncedStudentDevice;
  assert.equal(revocation.operation, "UPDATED");
  assert.equal(oldPayload.status, "REVOKED");
  assert.equal(oldPayload.syncId, legacy.syncId, "the revocation names the old device row");
  assert.equal(creation.operation, "CREATED");
  assert.equal(newPayload.status, "ACTIVE");
  assert.notEqual(
    newPayload.cloudDeviceRef,
    oldPayload.cloudDeviceRef,
    "a replacement is a new device reference"
  );

  const rows = await deviceRows(student.studentId);
  assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1);
});

test("3. an admin device reset publishes UPDATED with status REVOKED", async () => {
  const student = students.deviceReset;
  const device = await seedActiveDevice(student, {
    discoverable: true,
    suffix: "device-reset",
  });

  const res = await postJson(
    `/api/admin/students/${student.studentId}/device/reset`,
    {},
    adminCookie()
  );
  assert.equal(res.status, 200);

  const events = await eventsFor(student);
  assert.equal(events.length, 1, "the committed reset must be published");
  assert.equal(events[0].operation, "UPDATED");

  const payload = events[0].payload as SyncedStudentDevice;
  assert.equal(payload.status, "REVOKED");
  assert.equal(payload.syncId, device.syncId);
  assert.equal(payload.cloudDeviceRef, device.deviceRef);
  assert.equal(payload.cloudStudentSyncId, student.syncId);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ALLOWED_PAYLOAD_KEYS,
    "a reset payload carries identity, parent and status only"
  );

  const rows = await deviceRows(student.studentId);
  assert.equal(rows[0].status, "REVOKED", "the row itself is revoked, never deleted");
});

test("4. a registration reset publishes the device only when it revokes one", async () => {
  const withDevice = students.regReset;
  await seedActiveDevice(withDevice, { discoverable: true, suffix: "reg-reset" });

  const revoked = await postJson(
    `/api/admin/students/${withDevice.studentId}/reset-registration`,
    {},
    adminCookie()
  );
  assert.equal(revoked.status, 200);

  const events = await eventsFor(withDevice);
  assert.equal(events.length, 1, "a revoked device must be published");
  assert.equal(events[0].operation, "UPDATED");
  const payload = events[0].payload as SyncedStudentDevice;
  assert.equal(payload.status, "REVOKED");

  const withoutDevice = students.regResetNoDevice;
  const noDeviceReset = await postJson(
    `/api/admin/students/${withoutDevice.studentId}/reset-registration`,
    {},
    adminCookie()
  );
  assert.equal(noDeviceReset.status, 200);
  assert.equal(
    (await eventsFor(withoutDevice)).length,
    0,
    "a student with no device produces no device event"
  );
  assert.equal((await deviceRows(withoutDevice.studentId)).length, 0);
});

test("5. a rolled-back registration reset publishes no device event", async () => {
  // The device and the emission both happen INSIDE the reset transaction; the
  // audit-log insert at the end fails on a foreign key, so everything - status
  // change, revocation and event - must roll back together.
  const student = students.rollback;
  const device = await seedActiveDevice(student, {
    discoverable: true,
    suffix: "rollback",
  });

  await assert.rejects(() => resetStudentRegistration(999999999, student.studentId));

  const rows = await deviceRows(student.studentId);
  assert.equal(rows[0].status, "ACTIVE", "the failed reset must not revoke anything");
  assert.equal(
    (await eventsFor(student)).length,
    0,
    "a rolled-back reset must leave no event behind"
  );
  assert.ok(device.deviceRef);
});

test("6. no device event anywhere carries credential material", async () => {
  // Runs after every emission scenario above, so the scan covers enrollment,
  // upgrade, admin reset, registration reset - the whole vocabulary.
  const events = await emittedDeviceEvents();
  assert.ok(events.length >= 4, `expected the emission scenarios to publish, saw ${events.length}`);

  for (const event of events) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const key of FORBIDDEN_PAYLOAD_SUBSTRINGS) {
      assert.ok(
        !serialised.includes(key),
        `device payload must not contain "${key}"`
      );
    }
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ALLOWED_PAYLOAD_KEYS,
      "every device payload carries only identity, parent and status"
    );
  }
});

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

test("7. the edge applies an ACTIVE device event into the projection", async () => {
  const consumerId = await freshConsumer("apply");
  await resetReplica();
  const payload = devicePayload();
  const created = deviceEvent({ cursor: 1, payload });

  const result = await applyChangeBatch(consumerId, [created]);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, 1);

  const row = await replicaByDeviceRef(payload.cloudDeviceRef);
  assert.ok(row, "the device state must exist in the projection");
  assert.equal(row.cloud_sync_id, payload.syncId, "the cloud identity is preserved");
  assert.equal(row.cloud_device_ref, payload.cloudDeviceRef);
  assert.equal(row.cloud_student_sync_id, payload.cloudStudentSyncId);
  assert.equal(row.status, "ACTIVE");
  assert.equal(
    Number(row.student_id),
    students.one.studentId,
    "the parent UUID resolved to the local student row"
  );
});

test("8. a REVOKED status refresh updates the same projection row", async () => {
  const consumerId = await freshConsumer("refresh");
  await resetReplica();
  const payload = devicePayload();
  const first = await applyChangeBatch(consumerId, [
    deviceEvent({ cursor: 1, payload }),
  ]);
  assert.equal(first.applied, 1);

  const revoked = { ...payload, status: "REVOKED" as const };
  const second = await applyChangeBatch(consumerId, [
    deviceEvent({ cursor: 2, operation: "UPDATED", payload: revoked }),
  ]);
  assert.equal(second.applied, 1);

  const rows = await replicaRows(students.one.studentId);
  const matching = rows.filter((r) => r.cloud_device_ref === payload.cloudDeviceRef);
  assert.equal(matching.length, 1, "a status refresh must never duplicate the device");
  assert.equal(matching[0].status, "REVOKED");
  assert.equal(matching[0].cloud_sync_id, payload.syncId, "the identity never changes");

  // The revoked row survives: history references it and a re-delivered
  // revocation has to resolve to the same row.
  assert.equal(matching[0].cloud_sync_id, payload.syncId);
  assert.equal(matching[0].cloud_student_sync_id, payload.cloudStudentSyncId);
});

test("9. replaying a device event is idempotent", async () => {
  const consumerId = await freshConsumer("replay");
  await resetReplica();
  const payload = devicePayload();
  const created = deviceEvent({ cursor: 1, payload });

  const first = await applyChangeBatch(consumerId, [created]);
  assert.equal(first.applied, 1);

  // A lost response or a restart re-delivers exactly what was already applied.
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = 0 WHERE consumer_id = $1`,
    [consumerId]
  );
  const replay = await applyChangeBatch(consumerId, [created]);
  assert.equal(replay.applied, 0, "an already-processed event must not re-apply");
  assert.equal(replay.skipped, 1);
  assert.equal(await cursorOf(consumerId), 1);

  // A different event id carrying the same state is absorbed by the upsert
  // rather than by the receipt, so both idempotency layers are covered.
  const repeat = deviceEvent({ cursor: 2, operation: "UPDATED", payload });
  const second = await applyChangeBatch(consumerId, [repeat]);
  assert.equal(second.applied, 1);

  assert.equal(
    (await replicaRows(students.one.studentId)).filter(
      (r) => r.cloud_device_ref === payload.cloudDeviceRef
    ).length,
    1,
    "replay must not create a second device row"
  );
});

test("10. a device whose student has not synchronized fails safely", async () => {
  const consumerId = await freshConsumer("missing-student");
  await resetReplica();
  const payload = devicePayload({ cloudStudentSyncId: randomUUID() });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [deviceEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      return true;
    }
  );

  assert.equal(
    await replicaByDeviceRef(payload.cloudDeviceRef),
    null,
    "a missing student must not write a partial device row"
  );
  assert.equal(await cursorOf(consumerId), 0, "a failure must not advance the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a failure must not be acknowledged");
});

test("11. a second ACTIVE device for the same student is refused", async () => {
  const consumerId = await freshConsumer("second-active");
  await resetReplica();
  const firstPayload = devicePayload();
  const applied = await applyChangeBatch(consumerId, [
    deviceEvent({ cursor: 1, payload: firstPayload }),
  ]);
  assert.equal(applied.applied, 1);

  const secondPayload = devicePayload();
  await assert.rejects(
    () => applyChangeBatch(consumerId, [deviceEvent({ cursor: 2, payload: secondPayload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /second device ACTIVE/);
      return true;
    }
  );

  assert.equal(
    await replicaByDeviceRef(secondPayload.cloudDeviceRef),
    null,
    "the refused device must not be written"
  );
  assert.equal(
    await cursorOf(consumerId),
    1,
    "the refusal holds the cursor at the last applied event"
  );
  assert.equal(await receiptCount(consumerId), 1);
});

test("12. a device is never re-homed onto another student", async () => {
  const consumerId = await freshConsumer("re-home");
  await resetReplica();
  const payload = devicePayload();
  const applied = await applyChangeBatch(consumerId, [
    deviceEvent({ cursor: 1, payload }),
  ]);
  assert.equal(applied.applied, 1);

  // The same device and the same device reference, but a different student: a
  // device never changes owner, so the event must be refused rather than
  // moving the row.
  const rehomed = {
    ...payload,
    cloudStudentSyncId: students.upgrade.syncId,
    status: "REVOKED" as const,
  };
  await assert.rejects(
    () => applyChangeBatch(consumerId, [deviceEvent({ cursor: 2, payload: rehomed })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /never changes owner/);
      return true;
    }
  );

  const row = await replicaByDeviceRef(payload.cloudDeviceRef);
  assert.ok(row);
  assert.equal(
    Number(row.student_id),
    students.one.studentId,
    "the row must stay with the student it belongs to"
  );
  assert.equal(row.status, "ACTIVE", "the refused event must not change the status");
  assert.equal(await cursorOf(consumerId), 1, "the refusal holds the cursor");
});

test("13. a sync_id and device reference held by different rows is refused", async () => {
  const consumerId = await freshConsumer("ambiguous");
  await resetReplica();
  const rowX = { syncId: randomUUID(), deviceRef: randomUUID() };
  const rowY = { syncId: randomUUID(), deviceRef: randomUUID() };
  for (const seed of [rowX, rowY]) {
    await pool.query(
      `INSERT INTO sync_student_devices
         (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status)
       VALUES ($1, $2, $3, $4, 'REVOKED')`,
      [seed.syncId, seed.deviceRef, students.one.studentId, students.one.syncId]
    );
  }

  // Row X's identity with row Y's device reference: two different local rows
  // could both be "the" device in this event, and the choice is a human's.
  const payload = devicePayload({
    syncId: rowX.syncId,
    cloudDeviceRef: rowY.deviceRef,
    status: "REVOKED",
  });
  await assert.rejects(
    () => applyChangeBatch(consumerId, [deviceEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /Refusing to guess/);
      return true;
    }
  );

  assert.equal(await cursorOf(consumerId), 0, "a refusal must hold the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a refusal must not be acknowledged");
  const x = await replicaByDeviceRef(rowX.deviceRef);
  const y = await replicaByDeviceRef(rowY.deviceRef);
  assert.equal(x.cloud_sync_id, rowX.syncId, "row X keeps its own identity");
  assert.equal(y.cloud_sync_id, rowY.syncId, "row Y keeps its own identity");
});

test("14. a row already holding the device adopts the cloud sync id", async () => {
  const consumerId = await freshConsumer("adopt");
  await resetReplica();
  const localSyncId = randomUUID();
  const deviceRef = randomUUID();
  await pool.query(
    `INSERT INTO sync_student_devices
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status)
     VALUES ($1, $2, $3, $4, 'REVOKED')`,
    [localSyncId, deviceRef, students.one.studentId, students.one.syncId]
  );

  const payload = devicePayload({ cloudDeviceRef: deviceRef, status: "REVOKED" });
  const result = await applyChangeBatch(consumerId, [deviceEvent({ cursor: 1, payload })]);
  assert.equal(result.applied, 1);

  const row = await replicaByDeviceRef(deviceRef);
  assert.ok(row, "adoption must never duplicate the device");
  assert.equal(row.cloud_sync_id, payload.syncId, "the row adopts the cloud identity");
  assert.equal(row.status, "REVOKED");
  assert.notEqual(row.cloud_sync_id, localSyncId);

  const rows = await replicaRows(students.one.studentId);
  const holding = rows.filter(
    (r) => r.cloud_sync_id === localSyncId || r.cloud_sync_id === payload.syncId
  );
  assert.equal(holding.length, 1, "adoption updates the one row rather than inserting");
  assert.equal(
    rows.filter((r) => r.cloud_device_ref === deviceRef).length,
    1,
    "one device reference means exactly one replica row"
  );
});

test("15. an unsupported device status fails the batch", async () => {
  const consumerId = await freshConsumer("bad-status");
  await resetReplica();
  const payload = devicePayload({
    // A value the `sync_student_devices` CHECK constraint does not admit.
    status: "SUSPENDED" as SyncedStudentDevice["status"],
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [deviceEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /unsupported status/);
      return true;
    }
  );

  assert.equal(await replicaByDeviceRef(payload.cloudDeviceRef), null);
  assert.equal(await cursorOf(consumerId), 0, "the cursor must not advance");
  assert.equal(await receiptCount(consumerId), 0, "the event must not be acknowledged");
});

// ---------------------------------------------------------------------------
// Login stays local
// ---------------------------------------------------------------------------

test("16. password login resolves a device_ref binding cookie and refreshes it", async () => {
  const student = students.enroll;
  const rows = await deviceRows(student.studentId);
  assert.equal(rows.length, 1);
  const deviceRef = rows[0].device_ref as string;
  const credentialId = rows[0].credential_id as string;
  assert.notEqual(deviceRef, credentialId);

  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: student.matric, password: TEST_PASSWORD },
    { cookie: `${authConfig.deviceBindingCookieName}=${deviceRef}` }
  );
  assert.equal(res.status, 200, "the binding must resolve without a WebAuthn ceremony");
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(body.user.matricNumber, student.matric);

  const setCookies = res.headers.getSetCookie();
  assert.ok(
    setCookies.some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    "a bound login mints a session"
  );
  const refreshed = setCookies.find((c) =>
    c.startsWith(`${authConfig.deviceBindingCookieName}=`)
  );
  assert.ok(refreshed, "the binding cookie must be refreshed");
  const refreshedValue = refreshed.slice(
    refreshed.indexOf("=") + 1,
    refreshed.indexOf(";")
  );
  assert.equal(
    refreshedValue,
    deviceRef,
    "the refreshed cookie carries the device reference, never the credential id"
  );

  const binding = await get("/api/auth/student/device-binding", {
    cookie: `${authConfig.deviceBindingCookieName}=${deviceRef}`,
  });
  assert.equal(binding.status, 200);
  assert.deepEqual(await binding.json(), {
    hasDeviceBinding: true,
    matricNumber: student.matric,
  });
});

test("17. password login resolves a replica binding with no credential on this edge", async () => {
  const student = students.replicaLogin;
  const cloudDeviceRef = randomUUID();
  const cloudDeviceSyncId = randomUUID();
  await pool.query(
    `INSERT INTO sync_student_devices
       (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [cloudDeviceSyncId, cloudDeviceRef, student.studentId, student.syncId]
  );

  assert.equal(
    (await deviceRows(student.studentId)).length,
    0,
    "this student holds no local credential at all"
  );

  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: student.matric, password: TEST_PASSWORD },
    { cookie: `${authConfig.deviceBindingCookieName}=${cloudDeviceRef}` }
  );
  assert.equal(
    res.status,
    200,
    "a cloud device binding plus the local password is enough to sign in"
  );
  const body = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(body.user.matricNumber, student.matric);
  assert.ok(
    res.headers.getSetCookie().some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    "a replica-resolved bound login mints a session"
  );

  const binding = await get("/api/auth/student/device-binding", {
    cookie: `${authConfig.deviceBindingCookieName}=${cloudDeviceRef}`,
  });
  assert.equal(binding.status, 200);
  assert.deepEqual(await binding.json(), {
    hasDeviceBinding: true,
    matricNumber: student.matric,
  });
});

test("18. a revoked replica binding is refused", async () => {
  const student = students.replicaLogin;
  const revoked = { ...devicePayload(), status: "REVOKED" as const };

  // The cloud revokes the device; the edge applies it into the same projection
  // row this browser's binding resolves against.
  const consumerId = await freshConsumer("replica-revoke");
  const existing = await replicaRows(student.studentId);
  assert.equal(existing.length, 1);
  const applied = await applyChangeBatch(consumerId, [
    deviceEvent({
      cursor: 1,
      operation: "UPDATED",
      payload: {
        version: SYNC_PAYLOAD_VERSION,
        syncId: existing[0].cloud_sync_id as string,
        cloudDeviceRef: existing[0].cloud_device_ref as string,
        cloudStudentSyncId: student.syncId,
        status: "REVOKED",
      },
    }),
  ]);
  assert.equal(applied.applied, 1);
  assert.ok(revoked.status === "REVOKED");

  const cookie = { cookie: `${authConfig.deviceBindingCookieName}=${existing[0].cloud_device_ref}` };
  const res = await postJson(
    "/api/auth/student/login",
    { matricNumber: student.matric, password: TEST_PASSWORD },
    cookie
  );
  assert.equal(res.status, 401, "a revoked binding must not sign anyone in");
  assert.equal(
    res.headers.getSetCookie().some((c) => c.startsWith(`${authConfig.cookieName}=`)),
    false,
    "no session may be created from a revoked binding"
  );

  const binding = await get("/api/auth/student/device-binding", cookie);
  assert.equal(binding.status, 200);
  assert.deepEqual(
    await binding.json(),
    { hasDeviceBinding: false },
    "the frontend must fall back to normal login"
  );
});
