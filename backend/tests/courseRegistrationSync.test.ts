// Task: cloud -> edge course-registration synchronization.
//
// Two halves are tested separately and then together:
//
// - Emission: a cloud registration (a student registering, or an admin
//   enrolling) writes its change event in the SAME transaction as the
//   registration row, so a committed registration is always published and a
//   rolled-back one never is. The payload is checked field by field, because
//   "the event carries identity and status, and nothing else" is a property of
//   the payload that has to be asserted, not assumed.
//
// - Application: the edge writes the registration into its own REAL
//   `course_registrations` table, resolving both parents by cloud UUID,
//   preserving the cloud `sync_id`, staying idempotent under replay, adopting
//   the identity onto a pre-existing local pair instead of duplicating it, and
//   refusing rather than guessing when two local rows could both be the
//   registration in the event.
//
// The applier tests build their events in memory with a dedicated consumer,
// the same way studentSync.test.ts exercises the applier: an event the
// database has never seen is the only way to prove what the INSERT path does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { SYNC_PAYLOAD_VERSION } from "../src/config/sync";
import { pool } from "../src/db/pool";
import { adminEnrollStudent } from "../src/services/courseOfferingStore";
import { registerCourses } from "../src/services/studentCourseRegistrationStore";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { SyncApplyError } from "../src/services/syncErrors";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncOperation,
  SyncedCourseRegistration,
} from "../src/types/sync";

/** Course codes and matric numbers are upper-cased, so the prefix is too. */
const PREFIX = `REGCSYNC${Date.now().toString(36).toUpperCase()}`;
const CONSUMER_PREFIX = `${PREFIX}-`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every field the registration payload is allowed to carry. */
const ALLOWED_PAYLOAD_KEYS = [
  "cloudCourseOfferingSyncId",
  "cloudRegistrationId",
  "cloudStudentSyncId",
  "status",
  "syncId",
  "version",
].sort();

let facultyId = 0;
let departmentId = 0;
let levelIdValue = 0;
let academicSessionId = 0;
let semesterId = 0;
let adminUserId = 0;

let studentOneUserId = 0;
let studentOneId = 0;
let studentOneSyncId = "";
let studentTwoUserId = 0;
let studentTwoId = 0;
let studentTwoSyncId = "";
let studentThreeUserId = 0;
let studentThreeId = 0;
let studentThreeSyncId = "";

let offeringOneId = 0;
let offeringOneSyncId = "";
let offeringTwoId = 0;
let offeringTwoSyncId = "";
let offeringThreeId = 0;
let offeringThreeSyncId = "";

/** Offering identities this file's events can belong to. */
let myOfferingSyncIds: Set<string> = new Set();

/** Feed position taken before this file emitted anything. */
let feedFloor = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Registration events this file produced, oldest first. */
async function emittedRegistrationEvents(): Promise<SyncChangeEvent[]> {
  const batch = await listChangeEventsSince(feedFloor, 500);
  return batch.events.filter((event) => {
    if (event.entityType !== "course_registration") return false;
    const payload = event.payload as SyncedCourseRegistration;
    return myOfferingSyncIds.has(payload.cloudCourseOfferingSyncId);
  });
}

async function freshConsumer(suffix: string): Promise<string> {
  const consumerId = `${CONSUMER_PREFIX}${suffix}`;
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [
    consumerId,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id = $1`, [
    consumerId,
  ]);
  await readCursor(consumerId);
  return consumerId;
}

function registrationPayload(
  overrides: Partial<SyncedCourseRegistration> = {}
): SyncedCourseRegistration {
  return {
    version: SYNC_PAYLOAD_VERSION,
    syncId: randomUUID(),
    cloudRegistrationId: 9001,
    cloudStudentSyncId: studentOneSyncId,
    cloudCourseOfferingSyncId: offeringOneSyncId,
    status: "ENROLLED",
    ...overrides,
  };
}

function registrationEvent(input: {
  cursor: number;
  operation?: SyncOperation;
  payload: SyncedCourseRegistration;
  eventId?: string;
  entityType?: SyncEntityType;
}): SyncChangeEvent {
  return {
    eventId: input.eventId ?? randomUUID(),
    cursor: input.cursor,
    entityType: input.entityType ?? "course_registration",
    entityId: input.payload.syncId,
    operation: input.operation ?? "CREATED",
    payload: input.payload as SyncChangeEvent["payload"],
    recordedAt: new Date().toISOString(),
  };
}

async function findRegistration(studentId: number, offeringId: number) {
  const result = await pool.query(
    `SELECT id, sync_id, student_id, course_offering_id, status
     FROM course_registrations
     WHERE student_id = $1 AND course_offering_id = $2`,
    [studentId, offeringId]
  );
  return result.rows[0] ?? null;
}

async function countRegistrations(
  where: string,
  params: unknown[]
): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM course_registrations WHERE ${where}`,
    params
  );
  return result.rows[0].n as number;
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

before(async () => {
  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`${PREFIX} Faculty`, `${PREFIX}FAC`]
  );
  facultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3)
     RETURNING id`,
    [`${PREFIX} Department`, `${PREFIX}DEPT`, facultyId]
  );
  departmentId = Number(department.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  levelIdValue = Number(level.rows[0].id);

  // registerCourses picks the lowest-id active session, so this file must be
  // the only active one: deactivate everything, then insert its own.
  await pool.query(`UPDATE academic_sessions SET is_active = false`);
  const session = await pool.query(
    `INSERT INTO academic_sessions (name, is_active) VALUES ($1, true)
     RETURNING id`,
    [`${PREFIX} SESSION`]
  );
  academicSessionId = Number(session.rows[0].id);

  const semester = await pool.query(`SELECT id FROM semesters ORDER BY id LIMIT 1`);
  semesterId = Number(semester.rows[0].id);

  const admin = await pool.query(
    `INSERT INTO users (name, username, password_hash, role, status)
     VALUES ($1, $2, NULL, 'ADMIN', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Admin`, `${PREFIX}_ADMIN`]
  );
  adminUserId = Number(admin.rows[0].id);

  // Three students: every test below owns its own (student, offering) pair, so
  // no test can collide with another's rows.
  const students: Array<[number, number, string, string]> = [];
  for (const suffix of ["001", "002", "003"]) {
    const user = await pool.query(
      `INSERT INTO users (name, password_hash, role, status)
       VALUES ($1, NULL, 'STUDENT', 'ACTIVE') RETURNING id`,
      [`${PREFIX} Student ${suffix}`]
    );
    const student = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id, sync_id`,
      [Number(user.rows[0].id), `${PREFIX}/${suffix}`, departmentId, levelIdValue]
    );
    students.push([
      Number(user.rows[0].id),
      Number(student.rows[0].id),
      student.rows[0].sync_id as string,
      suffix,
    ]);
  }
  [studentOneUserId, studentOneId, studentOneSyncId] = students[0];
  [studentTwoUserId, studentTwoId, studentTwoSyncId] = students[1];
  [studentThreeUserId, studentThreeId, studentThreeSyncId] = students[2];

  // One offering per course: the UNIQUE (course, session, semester) triple
  // allows exactly one offering of a course in this session and semester.
  for (const suffix of ["C1", "C2", "C3"]) {
    const course = await pool.query(
      `INSERT INTO courses (course_code, title, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`${PREFIX}${suffix}`, `${PREFIX} Course ${suffix}`, departmentId, levelIdValue]
    );
    const offering = await pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
       VALUES ($1, $2, $3) RETURNING id, sync_id`,
      [Number(course.rows[0].id), academicSessionId, semesterId]
    );
    const offeringId = Number(offering.rows[0].id);
    const offeringSyncId = offering.rows[0].sync_id as string;
    if (suffix === "C1") {
      offeringOneId = offeringId;
      offeringOneSyncId = offeringSyncId;
    } else if (suffix === "C2") {
      offeringTwoId = offeringId;
      offeringTwoSyncId = offeringSyncId;
    } else {
      offeringThreeId = offeringId;
      offeringThreeSyncId = offeringSyncId;
    }
  }
  myOfferingSyncIds = new Set([
    offeringOneSyncId,
    offeringTwoSyncId,
    offeringThreeSyncId,
  ]);

  // Consumers from an earlier run would start at a stale cursor and break the
  // contiguity check, so this file's consumers are rebuilt every run.
  await pool.query(
    `DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`,
    [`${CONSUMER_PREFIX}%`]
  );
  await pool.query(
    `DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`,
    [`${CONSUMER_PREFIX}%`]
  );

  const max = await pool.query(
    `SELECT coalesce(max(cursor), 0)::bigint AS m FROM sync_change_events`
  );
  feedFloor = Number(max.rows[0].m);
});

after(async () => {
  // Registrations first, then their feed events (matched through this file's
  // offering identities), then the fixture in dependency order. The LIKE
  // patterns are only ever the upper-case prefix built above, which contains
  // no wildcard characters.
  await pool.query(`DELETE FROM course_registrations WHERE student_id = ANY($1::BIGINT[])`, [
    [studentOneId, studentTwoId, studentThreeId],
  ]);
  await pool.query(
    `DELETE FROM sync_change_events
      WHERE entity_type = 'course_registration'
        AND payload->'entity'->>'cloudCourseOfferingSyncId' = ANY($1::TEXT[])`,
    [[offeringOneSyncId, offeringTwoSyncId, offeringThreeSyncId]]
  );
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(
    `DELETE FROM course_offerings WHERE course_id IN (
       SELECT id FROM courses WHERE course_code LIKE $1
     )`,
    [`${PREFIX}C%`]
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name = $1`, [
    `${PREFIX} SESSION`,
  ]);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE $1`, [
    `${PREFIX}C%`,
  ]);
  await pool.query(`DELETE FROM students WHERE matric_number LIKE $1`, [
    `${PREFIX}%`,
  ]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE $1 OR username = $2`,
    [`${PREFIX}%`, `${PREFIX}_ADMIN`]
  );
  await pool.query(`DELETE FROM departments WHERE code = $1`, [`${PREFIX}DEPT`]);
  await pool.query(`DELETE FROM faculties WHERE code = $1`, [`${PREFIX}FAC`]);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Cloud emission
// ---------------------------------------------------------------------------

test("1. a cloud registration creation emits exactly one CREATED course_registration event", async () => {
  const result = await registerCourses(studentOneUserId, [offeringOneId]);
  assert.ok(result.ok, `registration should succeed: ${result.ok ? "" : result.code}`);
  if (result.ok) {
    assert.equal(result.data.registered.length, 1);
    assert.equal(result.data.alreadyRegistered.length, 0);
  }

  const events = await emittedRegistrationEvents();
  assert.equal(events.length, 1, "one event per newly inserted registration");
  assert.equal(events[0].operation, "CREATED");
  assert.equal(events[0].entityType, "course_registration");

  const row = await findRegistration(studentOneId, offeringOneId);
  assert.ok(row, "the registration must exist");
  assert.equal(
    events[0].entityId,
    row.sync_id,
    "the event is addressed by the registration's sync_id"
  );
});

test("2. the event contains the stable registration identity", async () => {
  const row = await findRegistration(studentOneId, offeringOneId);
  assert.ok(row);
  const event = (await emittedRegistrationEvents()).find(
    (candidate) => candidate.entityId === row.sync_id
  );
  assert.ok(event, "the registration must have been published");
  const payload = event.payload as SyncedCourseRegistration;
  assert.match(payload.syncId, UUID_PATTERN, "sync_id is a UUID");
  assert.equal(payload.syncId, row.sync_id);
  assert.equal(
    payload.cloudRegistrationId,
    Number(row.id),
    "the cloud integer id is carried for diagnostics"
  );
});

test("3. the event contains the student sync_id", async () => {
  const row = await pool.query(
    `SELECT sync_id FROM students WHERE id = $1`,
    [studentOneId]
  );
  const studentSyncId = row.rows[0].sync_id as string;

  const event = (await emittedRegistrationEvents())[0];
  const payload = event.payload as SyncedCourseRegistration;
  assert.equal(
    payload.cloudStudentSyncId,
    studentSyncId,
    "the payload references the student by cloud UUID"
  );
  assert.match(payload.cloudStudentSyncId, UUID_PATTERN);
});

test("4. the event contains the course-offering sync_id", async () => {
  const row = await pool.query(
    `SELECT sync_id FROM course_offerings WHERE id = $1`,
    [offeringOneId]
  );
  const offeringSyncId = row.rows[0].sync_id as string;

  const event = (await emittedRegistrationEvents())[0];
  const payload = event.payload as SyncedCourseRegistration;
  assert.equal(
    payload.cloudCourseOfferingSyncId,
    offeringSyncId,
    "the payload references the offering by cloud UUID"
  );
  assert.match(payload.cloudCourseOfferingSyncId, UUID_PATTERN);
});

test("5. the event contains no authentication secrets and only the allowed fields", async () => {
  const forbidden = [
    "password",
    "passwordhash",
    "password_hash",
    "username",
    "argon",
    "$2b$",
    "credentialid",
    "credential_id",
    "publickey",
    "public_key",
    "counter",
    "challenge",
    "webauthn",
    "user_handle",
    "userhandle",
    "devicebinding",
    "device_binding",
    "remembered",
    "sessiontoken",
    "session_token",
    "cookie",
    "secret",
    "matric",
  ];

  const events = await emittedRegistrationEvents();
  assert.ok(events.length > 0);
  for (const event of events) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const key of forbidden) {
      assert.ok(
        !serialised.includes(key),
        `registration payload must not contain "${key}"`
      );
    }

    // The strongest form of the same claim: the payload has exactly the
    // identity, the two parent references and the status, so nothing can be
    // added to the event without this test failing first.
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ALLOWED_PAYLOAD_KEYS,
      "registration payload must carry only identity, parents and status"
    );
  }
});

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

test("6. the edge applies a new course_registration event into course_registrations", async () => {
  const consumerId = await freshConsumer("apply");
  const payload = registrationPayload({
    cloudStudentSyncId: studentTwoSyncId,
    cloudCourseOfferingSyncId: offeringOneSyncId,
  });
  const created = registrationEvent({ cursor: 1, payload });

  const result = await applyChangeBatch(consumerId, [created]);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, 1);

  const row = await findRegistration(studentTwoId, offeringOneId);
  assert.ok(row, "the synchronized registration must exist locally");
  assert.equal(row.status, "ENROLLED");
  assert.equal(
    row.sync_id,
    payload.syncId,
    "the local row keeps the identity the cloud issued"
  );
});

test("7. the student dependency resolves through students.sync_id", async () => {
  const row = await findRegistration(studentTwoId, offeringOneId);
  assert.ok(row);
  assert.equal(
    Number(row.student_id),
    studentTwoId,
    "the parent UUID resolved to the local student row"
  );

  const resolved = await pool.query(
    `SELECT id FROM students WHERE sync_id = $1`,
    [studentTwoSyncId]
  );
  assert.equal(Number(resolved.rows[0].id), Number(row.student_id));
});

test("8. the course offering dependency resolves through course_offering.sync_id", async () => {
  const row = await findRegistration(studentTwoId, offeringOneId);
  assert.ok(row);
  assert.equal(
    Number(row.course_offering_id),
    offeringOneId,
    "the parent UUID resolved to the local offering row"
  );

  const resolved = await pool.query(
    `SELECT id FROM course_offerings WHERE sync_id = $1`,
    [offeringOneSyncId]
  );
  assert.equal(Number(resolved.rows[0].id), Number(row.course_offering_id));
});

test("9. a missing student dependency fails safely", async () => {
  const consumerId = await freshConsumer("missing-student");
  const before = await countRegistrations(`course_offering_id = $1`, [
    offeringOneId,
  ]);
  const payload = registrationPayload({
    cloudStudentSyncId: randomUUID(),
    cloudCourseOfferingSyncId: offeringOneSyncId,
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [registrationEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      return true;
    }
  );

  const after = await countRegistrations(`course_offering_id = $1`, [
    offeringOneId,
  ]);
  assert.equal(after, before, "a missing student must not write a partial row");
});

test("10. a missing course offering dependency fails safely", async () => {
  const consumerId = await freshConsumer("missing-offering");
  const before = await countRegistrations(`student_id = $1`, [studentTwoId]);
  const payload = registrationPayload({
    cloudStudentSyncId: studentTwoSyncId,
    cloudCourseOfferingSyncId: randomUUID(),
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [registrationEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      return true;
    }
  );

  const after = await countRegistrations(`student_id = $1`, [studentTwoId]);
  assert.equal(after, before, "a missing offering must not write a partial row");
});

test("11. a missing dependency does not advance the cursor", async () => {
  // Both consumers from tests 9 and 10 failed inside the transaction, so the
  // cursor, the row and the receipt must all have rolled back together.
  for (const consumerId of [
    `${CONSUMER_PREFIX}missing-student`,
    `${CONSUMER_PREFIX}missing-offering`,
  ]) {
    assert.equal(await cursorOf(consumerId), 0, "a failed event must not move the cursor");
    assert.equal(
      await receiptCount(consumerId),
      0,
      "a failed event must not be acknowledged"
    );
  }
});

test("12. replaying the registration event is idempotent", async () => {
  const consumerId = await freshConsumer("replay");
  const payload = registrationPayload({
    cloudStudentSyncId: studentThreeSyncId,
    cloudCourseOfferingSyncId: offeringOneSyncId,
  });
  const created = registrationEvent({ cursor: 1, payload });

  const first = await applyChangeBatch(consumerId, [created]);
  assert.equal(first.applied, 1);

  // A lost response or a restart re-delivers exactly what was already applied:
  // rewind the cursor and hand over the same event again.
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = 0 WHERE consumer_id = $1`,
    [consumerId]
  );
  const replay = await applyChangeBatch(consumerId, [created]);
  assert.equal(replay.applied, 0, "an already-processed event must not re-apply");
  assert.equal(replay.skipped, 1);
  assert.equal(await cursorOf(consumerId), 1, "the cursor still moves forward");

  // A different event id carrying the same state must be absorbed by the
  // upsert rather than by the receipt, so both idempotency layers are covered.
  const repeat = registrationEvent({ cursor: 2, operation: "UPDATED", payload });
  const second = await applyChangeBatch(consumerId, [repeat]);
  assert.equal(second.applied, 1);

  const count = await countRegistrations(
    `student_id = $1 AND course_offering_id = $2`,
    [studentThreeId, offeringOneId]
  );
  assert.equal(count, 1, "replay must not create a second registration");
});

test("13. an existing registration is updated rather than duplicated", async () => {
  // A registration the edge wrote for itself before this feature existed: its
  // own local sync_id, currently DROPPED. The cloud event for the same pair
  // carries a DIFFERENT sync_id, so the local row must adopt the cloud
  // identity, keep its integer id and take the cloud's status - one row, not
  // two.
  const localSyncId = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status, sync_id)
     VALUES ($1, $2, 'DROPPED', $3) RETURNING id`,
    [studentOneId, offeringTwoId, localSyncId]
  );
  const localId = Number(inserted.rows[0].id);

  const consumerId = await freshConsumer("adopt");
  const payload = registrationPayload({
    cloudStudentSyncId: studentOneSyncId,
    cloudCourseOfferingSyncId: offeringTwoSyncId,
    status: "ENROLLED",
  });
  const result = await applyChangeBatch(consumerId, [
    registrationEvent({ cursor: 1, payload }),
  ]);
  assert.equal(result.applied, 1);

  const count = await countRegistrations(
    `student_id = $1 AND course_offering_id = $2`,
    [studentOneId, offeringTwoId]
  );
  assert.equal(count, 1, "adoption must never duplicate the pair");

  const row = await findRegistration(studentOneId, offeringTwoId);
  assert.ok(row);
  assert.equal(Number(row.id), localId, "the local integer id is preserved");
  assert.equal(
    row.sync_id,
    payload.syncId,
    "the local row adopts the cloud identity"
  );
  assert.equal(row.status, "ENROLLED", "the cloud status is written");
  assert.notEqual(row.sync_id, localSyncId);
});

test("14. DROPPED status synchronizes without deleting the local row", async () => {
  const consumerId = await freshConsumer("dropped");
  const payload = registrationPayload({
    cloudStudentSyncId: studentTwoSyncId,
    cloudCourseOfferingSyncId: offeringTwoSyncId,
    status: "ENROLLED",
  });
  const dropped = { ...payload, status: "DROPPED" as const };

  const result = await applyChangeBatch(consumerId, [
    registrationEvent({ cursor: 1, payload }),
    registrationEvent({ cursor: 2, operation: "UPDATED", payload: dropped }),
  ]);
  assert.equal(result.applied, 2);

  const row = await findRegistration(studentTwoId, offeringTwoId);
  assert.ok(row, "a dropped registration keeps its local row: history references it");
  assert.equal(row.status, "DROPPED");
  assert.equal(row.sync_id, payload.syncId, "the identity never changes");

  const count = await countRegistrations(
    `student_id = $1 AND course_offering_id = $2`,
    [studentTwoId, offeringTwoId]
  );
  assert.equal(count, 1, "a status change must not delete and re-insert");
});

test("15. an ambiguous natural-key match fails safely", async () => {
  const consumerId = await freshConsumer("ambiguous");

  // Two unrelated local registrations. The incoming event carries rowX's
  // cloud identity but rowY's (student, offering) pair: matching it would
  // re-home rowX onto a pair rowY already holds, which is a unique violation
  // meaning the two rows cannot be told apart from the event alone.
  const rowXSyncId = randomUUID();
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status, sync_id)
     VALUES ($1, $2, 'ENROLLED', $3)`,
    [studentOneId, offeringThreeId, rowXSyncId]
  );
  const rowYSyncId = randomUUID();
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status, sync_id)
     VALUES ($1, $2, 'ENROLLED', $3)`,
    [studentTwoId, offeringThreeId, rowYSyncId]
  );

  const payload = registrationPayload({
    syncId: rowXSyncId,
    cloudStudentSyncId: studentTwoSyncId,
    cloudCourseOfferingSyncId: offeringThreeSyncId,
  });
  await assert.rejects(
    () => applyChangeBatch(consumerId, [registrationEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /Refusing to guess/);
      return true;
    }
  );
  assert.equal(await cursorOf(consumerId), 0, "a refusal must hold the cursor");
  assert.equal(await receiptCount(consumerId), 0, "a refusal must not be acknowledged");

  const rowX = await findRegistration(studentOneId, offeringThreeId);
  const rowY = await findRegistration(studentTwoId, offeringThreeId);
  assert.ok(rowX && rowY, "both local rows must survive the refusal");
  assert.equal(rowX.sync_id, rowXSyncId, "rowX keeps its own identity");
  assert.equal(rowY.sync_id, rowYSyncId, "rowY keeps its own identity");
  assert.equal(rowY.status, "ENROLLED", "no cloud status may be written onto the wrong row");
});

test("16. a failed registration event rolls back completely", async () => {
  const consumerId = await freshConsumer("bad-status");
  const payload = registrationPayload({
    cloudStudentSyncId: studentThreeSyncId,
    cloudCourseOfferingSyncId: offeringThreeSyncId,
    // A value the `course_registrations` CHECK constraint does not admit: the
    // applier must refuse it before anything reaches the table.
    status: "SYNCED" as SyncedCourseRegistration["status"],
  });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [registrationEvent({ cursor: 1, payload })]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /unsupported status/);
      return true;
    }
  );

  assert.equal(
    await countRegistrations(`student_id = $1 AND course_offering_id = $2`, [
      studentThreeId,
      offeringThreeId,
    ]),
    0,
    "the failed event must leave no row"
  );
  assert.equal(await cursorOf(consumerId), 0, "the cursor must not advance");
  assert.equal(await receiptCount(consumerId), 0, "the event must not be acknowledged");
});

// ---------------------------------------------------------------------------
// Both halves together
// ---------------------------------------------------------------------------

test("17. cloud mutation and event commit or roll back together", async () => {
  // Success side: the admin enrollment commits its row AND its event, and both
  // are still readable outside the transaction that produced them.
  const enrolled = await adminEnrollStudent({
    adminUserId,
    offeringId: offeringTwoId,
    studentId: studentThreeId,
  });
  assert.ok(
    enrolled.ok,
    `admin enrollment should succeed: ${enrolled.ok ? "" : enrolled.code}`
  );
  assert.ok(await findRegistration(studentThreeId, offeringTwoId));

  const events = await emittedRegistrationEvents();
  const forEnrollment = events.filter(
    (event) =>
      (event.payload as SyncedCourseRegistration).cloudStudentSyncId ===
        studentThreeSyncId &&
      (event.payload as SyncedCourseRegistration).cloudCourseOfferingSyncId ===
        offeringTwoSyncId
  );
  assert.equal(forEnrollment.length, 1, "the committed enrollment is published");

  // Failure side: an admin id that does not exist passes every business check,
  // inserts the registration and emits its event - and THEN fails the audit-log
  // foreign key. The whole transaction, event included, must roll back.
  await assert.rejects(() =>
    adminEnrollStudent({
      adminUserId: 999999999,
      offeringId: offeringThreeId,
      studentId: studentThreeId,
    })
  );

  assert.equal(
    await findRegistration(studentThreeId, offeringThreeId),
    null,
    "a rolled-back enrollment must leave no registration"
  );
  const afterFailure = await emittedRegistrationEvents();
  const publishedForFailed = afterFailure.filter(
    (event) =>
      (event.payload as SyncedCourseRegistration).cloudCourseOfferingSyncId ===
        offeringThreeSyncId
  );
  assert.equal(
    publishedForFailed.length,
    0,
    "a rolled-back enrollment must leave no events behind"
  );
});

test("18. existing uniqueness constraints remain enforced", async () => {
  // The pair unique constraint from migration 001 is what stops two
  // registrations for one student and one offering; a second local sync_id
  // from migration 020 is what stops two cloud identities resolving to one row.
  const pairConstraint = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'course_registrations'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%student_id%'
       AND pg_get_constraintdef(oid) LIKE '%course_offering_id%'`
  );
  assert.equal(pairConstraint.rowCount, 1, "the (student, offering) pair must stay unique");

  const syncIndex = await pool.query(
    `SELECT 1 FROM pg_indexes
     WHERE tablename = 'course_registrations'
       AND indexname = 'idx_course_registrations_sync_id'`
  );
  assert.equal(syncIndex.rowCount, 1, "sync_id must stay unique");

  // Behavioral proof, not just catalog proof: the database itself refuses both
  // duplicates.
  const existing = await findRegistration(studentOneId, offeringOneId);
  assert.ok(existing);
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO course_registrations (student_id, course_offering_id)
         VALUES ($1, $2)`,
        [studentOneId, offeringOneId]
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "23505");
      return true;
    }
  );
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO course_registrations (student_id, course_offering_id, sync_id)
         VALUES ($1, $2, $3)`,
        [studentThreeId, offeringThreeId, existing.sync_id]
      ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "23505");
      return true;
    }
  );

  assert.equal(
    await countRegistrations(`student_id = $1 AND course_offering_id = $2`, [
      studentOneId,
      offeringOneId,
    ]),
    1,
    "the original pair still has exactly one row"
  );
  assert.equal(
    await countRegistrations(`student_id = $1 AND course_offering_id = $2`, [
      studentThreeId,
      offeringThreeId,
    ]),
    0,
    "neither duplicate insert was written"
  );
});
