// Task: cloud -> edge student synchronization.
//
// Two halves are tested separately and then together:
//
// - Emission: a cloud student import or a cloud status change writes its change
//   event in the SAME transaction as the student row, so a committed student is
//   always published and a rolled-back one never is. The payload is checked
//   field by field, because "no authentication material in the feed" is a
//   property of the payload that has to be asserted, not assumed.
//
// - Application: the edge writes a student into its own `users` + `students`
//   rows, preserving the cloud `sync_id`, creating the local account with no
//   password, staying idempotent under replay, and refusing rather than guessing
//   when two rows could both be the student in the event.
//
// The applier tests build their events in memory with a dedicated consumer, the
// same way syncMasterData.test.ts exercises natural-key adoption: an event the
// database has never seen is the only way to prove what the INSERT path does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import ExcelJS from "exceljs";
import { SYNC_PAYLOAD_VERSION } from "../src/config/sync";
import { pool } from "../src/db/pool";
import { updateStudentStatus } from "../src/services/adminStudentStore";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { SyncApplyError } from "../src/services/syncErrors";
import { confirmImport, previewImport } from "../src/services/studentImportStore";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncOperation,
  SyncedStudent,
} from "../src/types/sync";

/** Upper-cased by `normalizeMatric`, so the prefix is upper-case by design. */
const PREFIX = `STUDSYNC${Date.now().toString(36).toUpperCase()}`;
const CONSUMER_PREFIX = `${PREFIX}-`;

const MATRIC_ONE = `${PREFIX}/001`;
const MATRIC_TWO = `${PREFIX}/002`;
const MATRIC_CONFLICT = `${PREFIX}/CONFLICT`;

const LIVE_CONSUMER = `${PREFIX}-live`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every field the student payload is allowed to carry. */
const ALLOWED_PAYLOAD_KEYS = [
  "cloudDepartmentSyncId",
  "cloudLevelSyncId",
  "cloudStudentId",
  "matricNumber",
  "name",
  "status",
  "syncId",
  "version",
].sort();

let departmentId = 0;
let departmentSyncId = "";
let levelIdValue = 0;
let levelSyncId = "";
let adminUserId = 0;
/** sync_id of the synthetic events applied in tests 7 and 11. */
let edgeOneSyncId = "";
let updateSyncId = "";
/** Feed position taken before this file emitted anything. */
let feedFloor = 0;
/** Cursor the live consumer must sit on: one before this file's first event. */
let liveFloor = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildWorkbook(rows: Array<[string, string]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(["Student Name", "Matric Number"]);
  sheet.addRows(rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Runs the real preview + confirm pair the admin import route calls. */
async function importRows(rows: Array<[string, string]>): Promise<void> {
  const preview = await previewImport(
    departmentId,
    levelIdValue,
    await buildWorkbook(rows)
  );
  assert.ok(preview.ok, `preview should succeed: ${preview.ok ? "" : preview.code}`);
  const confirmed = await confirmImport(preview.data.previewToken);
  assert.ok(
    confirmed.ok,
    `confirm should succeed: ${confirmed.ok ? "" : confirmed.code}`
  );
}

/** Student events this file produced, oldest first. */
async function emittedStudentEvents(): Promise<SyncChangeEvent[]> {
  const batch = await listChangeEventsSince(feedFloor, 500);
  return batch.events.filter((event) => {
    if (event.entityType !== "student") return false;
    const matric = (event.payload as SyncedStudent).matricNumber;
    return typeof matric === "string" && matric.startsWith(PREFIX);
  });
}

/**
 * Drain the feed exactly the way the worker does: ask for the next page from
 * this consumer's own cursor and apply it in one transaction.
 */
async function drainLiveFeed() {
  const cursor = await readCursor(LIVE_CONSUMER);
  const batch = await listChangeEventsSince(cursor, 500);
  if (batch.events.length === 0) return null;
  return applyChangeBatch(LIVE_CONSUMER, batch.events);
}

/**
 * Park the live consumer one event before this file's first emission.
 *
 * The cursor column is assigned by a database sequence, which does not restart
 * when rows are deleted, so on a feed another suite's cleanup has emptied the
 * next event's cursor is far ahead of `max(cursor)` - seeding from `feedFloor`
 * would then look like a gap. Aligning to the first real event keeps the batch
 * the worker path sees gap-free whatever the feed looked like before this file.
 */
async function alignLiveConsumer(): Promise<number> {
  const events = await emittedStudentEvents();
  assert.ok(events.length > 0, "the file must have emitted before the live drain");
  const target = events[0].cursor - 1;
  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
     VALUES ($1, $2)
     ON CONFLICT (consumer_id) DO UPDATE SET last_cursor = EXCLUDED.last_cursor`,
    [LIVE_CONSUMER, target]
  );
  return target;
}

/**
 * A consumer whose cursor starts at 0, so an in-memory event can carry cursor 1
 * and every following event can be counted from there.
 */
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

function studentPayload(
  overrides: Partial<SyncedStudent> = {}
): SyncedStudent {
  return {
    version: SYNC_PAYLOAD_VERSION,
    syncId: randomUUID(),
    cloudStudentId: 9001,
    matricNumber: `${PREFIX}/EDGE`,
    name: `${PREFIX} Edge Student`,
    status: "PENDING",
    cloudDepartmentSyncId: departmentSyncId,
    cloudLevelSyncId: levelSyncId,
    ...overrides,
  };
}

function studentEvent(input: {
  cursor: number;
  operation: SyncOperation;
  payload: SyncedStudent;
  eventId?: string;
  entityType?: SyncEntityType;
}): SyncChangeEvent {
  return {
    eventId: input.eventId ?? randomUUID(),
    cursor: input.cursor,
    entityType: input.entityType ?? "student",
    entityId: input.payload.syncId,
    operation: input.operation,
    payload: input.payload as SyncChangeEvent["payload"],
    recordedAt: new Date().toISOString(),
  };
}

async function findStudentByMatric(matric: string) {
  const result = await pool.query(
    `SELECT s.id, s.sync_id, s.matric_number, s.department_id, s.level_id,
            u.id AS user_id, u.name, u.status, u.role, u.password_hash, u.username
     FROM students s
     JOIN users u ON u.id = s.user_id
     WHERE s.matric_number = $1`,
    [matric]
  );
  return result.rows[0] ?? null;
}

async function cursorOf(consumerId: string): Promise<number> {
  return readCursor(consumerId);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

before(async () => {
  // Parents are inserted directly so they publish nothing: every event this
  // file reads from the feed must be one of its own student events.
  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`${PREFIX} Faculty`, `${PREFIX}FAC`]
  );
  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3)
     RETURNING id, sync_id`,
    [`${PREFIX} Department`, `${PREFIX}DEPT`, Number(faculty.rows[0].id)]
  );
  departmentId = Number(department.rows[0].id);
  departmentSyncId = department.rows[0].sync_id as string;

  const level = await pool.query(
    `SELECT id, sync_id FROM levels WHERE name = 100`
  );
  levelIdValue = Number(level.rows[0].id);
  levelSyncId = level.rows[0].sync_id as string;

  const admin = await pool.query(
    `INSERT INTO users (name, username, password_hash, role, status)
     VALUES ($1, $2, NULL, 'ADMIN', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Admin`, `${PREFIX}_ADMIN`]
  );
  adminUserId = Number(admin.rows[0].id);

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
  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor) VALUES ($1, $2)`,
    [LIVE_CONSUMER, feedFloor]
  );
});

after(async () => {
  // Students first (they reference users), then their feed events, then the
  // fixture itself. The `LIKE` patterns are only ever the upper-case prefix
  // built above, which contains no wildcard characters.
  await pool.query(`DELETE FROM student_import_previews WHERE department_id = $1`, [
    departmentId,
  ]);
  await pool.query(
    `DELETE FROM sync_change_events
      WHERE entity_type = 'student'
        AND entity_id IN (
          SELECT sync_id::text FROM students WHERE matric_number LIKE $1
        )`,
    [`${PREFIX}%`]
  );
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id LIKE $1`, [
    `${CONSUMER_PREFIX}%`,
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

test("1. a cloud student import emits exactly one CREATED student event per row", async () => {
  await importRows([
    [`${PREFIX} Student One`, MATRIC_ONE],
    [`${PREFIX} Student Two`, MATRIC_TWO],
  ]);

  const events = await emittedStudentEvents();
  assert.equal(events.length, 2, "one event per imported student");
  assert.ok(
    events.every((event) => event.operation === "CREATED"),
    "a fresh import is a CREATED transition"
  );

  const local = await pool.query(
    `SELECT sync_id FROM students WHERE matric_number = ANY($1::TEXT[])`,
    [[MATRIC_ONE, MATRIC_TWO]]
  );
  const syncIds = new Set(local.rows.map((row) => row.sync_id as string));
  assert.equal(syncIds.size, 2);
  for (const event of events) {
    assert.ok(
      syncIds.has(event.entityId),
      "the event must be addressed by the student's sync_id"
    );
  }
});

test("2. the student event carries the stable cloud sync_id", async () => {
  const row = await findStudentByMatric(MATRIC_ONE);
  assert.ok(row, "the imported student must exist");
  const event = (await emittedStudentEvents()).find(
    (candidate) => candidate.entityId === row.sync_id
  );
  assert.ok(event, "the student must have been published");
  assert.match(String(event.entityId), UUID_PATTERN, "sync_id is a UUID");
  assert.equal(event.payload.syncId, row.sync_id);
  assert.equal(
    (event.payload as SyncedStudent).matricNumber,
    MATRIC_ONE,
    "the payload describes the same student the event is addressed to"
  );
});

test("3. the student event carries the current payload version", async () => {
  for (const event of await emittedStudentEvents()) {
    assert.equal(event.payload.version, SYNC_PAYLOAD_VERSION);
  }
});

test("4. no student event contains a password hash or any password field", async () => {
  for (const event of await emittedStudentEvents()) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const forbidden of [
      "password",
      "passwordhash",
      "password_hash",
      "username",
      "argon",
      "$2b$",
    ]) {
      assert.ok(
        !serialised.includes(forbidden),
        `student payload must not contain "${forbidden}"`
      );
    }
  }
});

test("5. no student event contains WebAuthn, device or session material", async () => {
  const forbidden = [
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
  ];

  for (const event of await emittedStudentEvents()) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const key of forbidden) {
      assert.ok(
        !serialised.includes(key),
        `student payload must not contain "${key}"`
      );
    }

    // The strongest form of the same claim: the payload has exactly the fields
    // a local users + students row is made of, so nothing can be added to the
    // event without this test failing first.
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ALLOWED_PAYLOAD_KEYS,
      "student payload must carry only the replicated profile fields"
    );
  }
});

test("6. a cloud status change emits an UPDATED event on the same sync_id", async () => {
  const before = await findStudentByMatric(MATRIC_ONE);
  assert.ok(before);

  const changed = await updateStudentStatus(adminUserId, Number(before.id), "INACTIVE");
  assert.ok(changed.ok, "PENDING to INACTIVE is a legal admin transition");

  const events = await emittedStudentEvents();
  const update = events.find(
    (event) =>
      event.entityId === before.sync_id && event.operation === "UPDATED"
  );
  assert.ok(update, "the status change must be published");
  const payload = update.payload as SyncedStudent;
  assert.equal(payload.syncId, before.sync_id, "the identity never changes");
  assert.equal(payload.status, "INACTIVE", "the payload carries the new state");
  assert.equal(payload.matricNumber, MATRIC_ONE);
});

test("7. the edge applies a new student event into users + students", async () => {
  const consumerId = await freshConsumer("apply");
  const payload = studentPayload({
    matricNumber: `${PREFIX}/EDGE1`,
    name: `${PREFIX} Edge One`,
  });
  const created = studentEvent({ cursor: 1, operation: "CREATED", payload });

  const result = await applyChangeBatch(consumerId, [created]);
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, 1);
  edgeOneSyncId = payload.syncId;
});

test("8. the applied student gets the correct users/students relationship", async () => {
  const row = await findStudentByMatric(`${PREFIX}/EDGE1`);
  assert.ok(row, "the synchronized student must exist locally");
  assert.equal(row.role, "STUDENT");
  assert.equal(row.name, `${PREFIX} Edge One`);
  assert.equal(row.status, "PENDING");
  assert.equal(
    row.password_hash,
    null,
    "a synchronized student must hold no local credential"
  );
  assert.equal(row.username, null, "no username crosses the boundary");
  assert.equal(Number(row.department_id), departmentId);
  assert.equal(row.sync_id !== undefined, true);

  // The relationship is one local user per local student, and the user the
  // student points at is the one whose fields were just checked.
  const users = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE id = $1`,
    [row.user_id]
  );
  assert.equal(users.rows[0].n, 1);
  const studentsForUser = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE user_id = $1`,
    [row.user_id]
  );
  assert.equal(studentsForUser.rows[0].n, 1);
});

test("9. the Cloud sync_id is preserved on the local row", async () => {
  const row = await findStudentByMatric(`${PREFIX}/EDGE1`);
  assert.ok(row);
  assert.equal(
    row.sync_id,
    edgeOneSyncId,
    "the local row keeps the identity the cloud issued in the applied event"
  );
  assert.match(String(row.sync_id), UUID_PATTERN);
});

test("10. replaying the student event creates no duplicate student", async () => {
  const consumerId = await freshConsumer("replay");
  const payload = studentPayload({
    matricNumber: `${PREFIX}/REPLAY`,
    name: `${PREFIX} Replay Student`,
  });
  const created = studentEvent({ cursor: 1, operation: "CREATED", payload });

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
  const repeat = studentEvent({
    cursor: 2,
    operation: "UPDATED",
    payload: { ...payload, name: `${PREFIX} Replay Student` },
  });
  const second = await applyChangeBatch(consumerId, [repeat]);
  assert.equal(second.applied, 1);

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE matric_number = $1`,
    [payload.matricNumber]
  );
  assert.equal(count.rows[0].n, 1, "replay must not create a second student");
});

test("11. a student update modifies the existing local replica", async () => {
  const consumerId = await freshConsumer("update");
  const created = studentEvent({
    cursor: 1,
    operation: "CREATED",
    payload: studentPayload({
      matricNumber: `${PREFIX}/UPDATE`,
      name: `${PREFIX} Update Student`,
      status: "ACTIVE",
    }),
  });
  await applyChangeBatch(consumerId, [created]);
  updateSyncId = created.payload.syncId;

  const before = await findStudentByMatric(`${PREFIX}/UPDATE`);
  assert.ok(before);

  const updated = studentEvent({
    cursor: 2,
    operation: "UPDATED",
    payload: studentPayload({
      matricNumber: `${PREFIX}/UPDATE`,
      name: `${PREFIX} Update Student Renamed`,
      status: "INACTIVE",
      syncId: before.sync_id as string,
      cloudStudentId: 9001,
    }),
  });
  const result = await applyChangeBatch(consumerId, [updated]);
  assert.equal(result.applied, 1);

  const after = await findStudentByMatric(`${PREFIX}/UPDATE`);
  assert.ok(after);
  assert.equal(
    Number(after.id),
    Number(before.id),
    "the update must rewrite the same local row, not insert a second one"
  );
  assert.equal(after.name, `${PREFIX} Update Student Renamed`);
  assert.equal(after.status, "INACTIVE");
});

test("12. a student update retains the same sync_id", async () => {
  const row = await findStudentByMatric(`${PREFIX}/UPDATE`);
  assert.ok(row);
  assert.equal(
    row.sync_id,
    updateSyncId,
    "the update must not re-issue the student's identity"
  );
  assert.match(String(row.sync_id), UUID_PATTERN);

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE matric_number = $1`,
    [`${PREFIX}/UPDATE`]
  );
  assert.equal(count.rows[0].n, 1, "one student, one identity");

  // Tests 11 and 12 applied in-memory events, so the feed itself must hold no
  // trace of them: only the cloud's emitters write to the feed.
  const feedRows = await pool.query(
    `SELECT 1 FROM sync_change_events
      WHERE entity_type = 'student'
        AND payload->'entity'->>'matricNumber' = $1`,
    [`${PREFIX}/UPDATE`]
  );
  assert.equal(feedRows.rowCount, 0, "synthetic events are never written to the feed");
});

test("13. an inactive student state propagates without deleting the local row", async () => {
  const consumerId = await freshConsumer("inactive");
  const payload = studentPayload({
    matricNumber: `${PREFIX}/INACTIVE`,
    name: `${PREFIX} Inactive Student`,
    status: "INACTIVE",
  });
  await applyChangeBatch(consumerId, [
    studentEvent({ cursor: 1, operation: "CREATED", payload }),
  ]);

  const row = await findStudentByMatric(`${PREFIX}/INACTIVE`);
  assert.ok(row, "an inactive student keeps its local row: history references it");
  assert.equal(row.status, "INACTIVE");

  // Re-activation is ordinary state, not a delete and re-insert.
  const reactivated = studentEvent({
    cursor: 2,
    operation: "UPDATED",
    payload: { ...payload, status: "ACTIVE" },
  });
  await applyChangeBatch(consumerId, [reactivated]);
  const after = await findStudentByMatric(`${PREFIX}/INACTIVE`);
  assert.ok(after);
  assert.equal(Number(after.id), Number(row.id));
  assert.equal(after.status, "ACTIVE");
});

test("14. student events are processed through the existing sync apply path", async () => {
  liveFloor = await alignLiveConsumer();
  const result = await drainLiveFeed();
  assert.ok(result, "the import events must be drainable by the worker path");
  assert.ok(result.applied >= 3, "two CREATED events plus the status change");

  const receipts = await pool.query(
    `SELECT count(*)::int AS n FROM sync_processed_events WHERE consumer_id = $1`,
    [LIVE_CONSUMER]
  );
  assert.equal(
    receipts.rows[0].n,
    result.applied,
    "every applied event must leave a receipt"
  );

  const local = await findStudentByMatric(MATRIC_ONE);
  assert.ok(local);
  assert.equal(local.status, "INACTIVE");
  assert.equal(local.sync_id !== undefined, true);
});

test("15. the cursor and processed-event receipts stay correct", async () => {
  const cursorBefore = await cursorOf(LIVE_CONSUMER);
  assert.ok(cursorBefore >= feedFloor, "the cursor must have advanced past the floor");

  const all = await emittedStudentEvents();
  const lastCursor = all[all.length - 1].cursor;
  assert.equal(cursorBefore, lastCursor, "the cursor follows the last applied event");

  // Nothing new to drain: an idle poll must not move the cursor at all.
  const idle = await drainLiveFeed();
  assert.equal(idle, null);
  assert.equal(await cursorOf(LIVE_CONSUMER), cursorBefore);

  // Rewind, as a lost response would, and re-deliver: receipts absorb it.
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = $2 WHERE consumer_id = $1`,
    [LIVE_CONSUMER, liveFloor]
  );
  const replay = await drainLiveFeed();
  assert.ok(replay);
  assert.equal(replay.applied, 0, "already-processed events must be skipped");
  assert.equal(replay.skipped, all.length);
  assert.equal(await cursorOf(LIVE_CONSUMER), lastCursor);

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE matric_number LIKE $1`,
    [`${PREFIX}%`]
  );
  const studentsAfterReplay = count.rows[0].n;
  assert.ok(studentsAfterReplay > 0);
  const again = await drainLiveFeed();
  assert.equal(again, null, "no further events: nothing to apply");
  const recount = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE matric_number LIKE $1`,
    [`${PREFIX}%`]
  );
  assert.equal(recount.rows[0].n, studentsAfterReplay, "no duplicates after replay");
});

test("16. a missing department or level dependency fails safely", async () => {
  const consumerId = await freshConsumer("missing-parent");
  const payload = studentPayload({
    matricNumber: `${PREFIX}/ORPHAN`,
    name: `${PREFIX} Orphan Student`,
    cloudDepartmentSyncId: randomUUID(),
  });
  const orphan = studentEvent({ cursor: 1, operation: "CREATED", payload });

  await assert.rejects(
    () => applyChangeBatch(consumerId, [orphan]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /referenced parent/);
      return true;
    }
  );

  assert.equal(
    await cursorOf(consumerId),
    0,
    "a failed student event must not move the cursor"
  );

  // The users row the applier inserted first must be gone with the rollback:
  // half a student is exactly the state this design refuses to leave behind.
  const user = await pool.query(
    `SELECT 1 FROM users WHERE name = $1`,
    [`${PREFIX} Orphan Student`]
  );
  assert.equal(user.rowCount, 0, "the batch must roll back completely");
  const student = await findStudentByMatric(`${PREFIX}/ORPHAN`);
  assert.equal(student, null);

  const receipts = await pool.query(
    `SELECT 1 FROM sync_processed_events WHERE consumer_id = $1`,
    [consumerId]
  );
  assert.equal(receipts.rowCount, 0, "a failed event must not be acknowledged");
});

test("17. ambiguous natural-key matching refuses to merge unrelated students", async () => {
  const consumerId = await freshConsumer("ambiguous");

  // An unrelated local student: same department and level, similar name, its
  // own identity. Nothing about the incoming cloud student points at it.
  const unrelatedUser = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, NULL, 'STUDENT', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Unrelated Local`]
  );
  const unrelatedSyncId = randomUUID();
  const unrelated = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id, sync_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      Number(unrelatedUser.rows[0].id),
      `${PREFIX}/LOCAL`,
      departmentId,
      levelIdValue,
      unrelatedSyncId,
    ]
  );

  // A local row with the same matric number whose account is not a student
  // account. Matching it by matric and adopting it would re-home the cloud
  // student onto an unrelated user, so the apply must refuse instead.
  const wrongUser = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, NULL, 'LECTURER', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Wrongly Linked Account`]
  );
  const wrongSyncId = randomUUID();
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id, sync_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      Number(wrongUser.rows[0].id),
      `${PREFIX}/SHADOW`,
      departmentId,
      levelIdValue,
      wrongSyncId,
    ]
  );

  const payload = studentPayload({
    matricNumber: `${PREFIX}/SHADOW`,
    name: `${PREFIX} Cloud Student`,
  });
  await assert.rejects(
    () =>
      applyChangeBatch(consumerId, [
        studentEvent({ cursor: 1, operation: "CREATED", payload }),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /STUDENT row/);
      return true;
    }
  );
  assert.equal(await cursorOf(consumerId), 0, "a refusal must hold the cursor");

  const shadow = await pool.query(
    `SELECT s.sync_id, u.name FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.matric_number = $1`,
    [`${PREFIX}/SHADOW`]
  );
  assert.equal(
    shadow.rows[0].sync_id,
    wrongSyncId,
    "the local row must keep its own identity after the refusal"
  );
  assert.equal(
    shadow.rows[0].name,
    `${PREFIX} Wrongly Linked Account`,
    "no cloud name may be written onto an unrelated account"
  );

  // The unrelated local student is untouched by an event that does not name it.
  const other = studentPayload({
    matricNumber: `${PREFIX}/DIFFERENT`,
    name: `${PREFIX} Cloud Other`,
  });
  const applied = await applyChangeBatch(consumerId, [
    studentEvent({ cursor: 1, operation: "CREATED", payload: other }),
  ]);
  assert.equal(applied.applied, 1);

  const untouched = await pool.query(
    `SELECT s.sync_id, u.name FROM students s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [Number(unrelated.rows[0].id)]
  );
  assert.equal(untouched.rows[0].sync_id, unrelatedSyncId);
  assert.equal(untouched.rows[0].name, `${PREFIX} Unrelated Local`);
});

test("18. student mutation and change-event creation commit or roll back together", async () => {
  // Success side: the import of test 1 committed its rows AND its events, and
  // both are still readable outside the transaction that produced them.
  const committed = await emittedStudentEvents();
  assert.ok(
    committed.some(
      (event) => (event.payload as SyncedStudent).matricNumber === MATRIC_ONE
    )
  );

  // Failure side: a preview whose confirm rolls back on a matric conflict must
  // publish nothing at all - not for the conflicting row, not for its peers.
  const preview = await previewImport(
    departmentId,
    levelIdValue,
    await buildWorkbook([
      [`${PREFIX} Conflict Victim`, MATRIC_CONFLICT],
      [`${PREFIX} Conflict Peer`, `${PREFIX}/PEER`],
    ])
  );
  assert.ok(preview.ok);

  const shadowUser = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, NULL, 'STUDENT', 'ACTIVE') RETURNING id`,
    [`${PREFIX} Conflict Blocker`]
  );
  await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4)`,
    [Number(shadowUser.rows[0].id), MATRIC_CONFLICT, departmentId, levelIdValue]
  );

  const confirmed = await confirmImport(preview.data.previewToken);
  assert.ok(!confirmed.ok, "the conflicting batch must be rejected");
  assert.equal(confirmed.ok ? "" : confirmed.code, "CONFLICT");

  const afterFailure = await emittedStudentEvents();
  const publishedForBatch = afterFailure.filter((event) => {
    const matric = (event.payload as SyncedStudent).matricNumber;
    return matric === MATRIC_CONFLICT || matric === `${PREFIX}/PEER`;
  });
  assert.equal(
    publishedForBatch.length,
    0,
    "a rolled-back import must leave no events behind"
  );

  const peer = await findStudentByMatric(`${PREFIX}/PEER`);
  assert.equal(peer, null, "and no half-imported student either");
});
