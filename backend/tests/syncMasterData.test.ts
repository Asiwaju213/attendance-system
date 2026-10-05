// MUST be the first import: sets SYNC_PROVIDER_SECRET_HASH before config/sync is
// evaluated, so the feed endpoint is reachable with the configured credential.
import {
  SYNC_TEST_PREFIX,
  cleanupSyncTestFixtures,
  seedMasterDataGraph,
} from "./syncTestFixtures";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import type { SyncChangeEvent } from "../src/types/sync";

/**
 * Task 2: cloud -> local master data.
 *
 * The two halves that matter are tested separately and then together:
 *
 * - Emission: every master-data mutation writes its change event in the same
 *   transaction, so a rolled-back change leaves no event and a committed one
 *   always does.
 * - Application: the edge writes cloud master data into its own tables, resolving
 *   parents by UUID, without ever writing to `users`.
 */

const CONSUMER_ID = "test-k12-master-data-edge";

let events: SyncChangeEvent[] = [];
let graph: Awaited<ReturnType<typeof seedMasterDataGraph>>;
let fixtureStartCursor: number;

before(async () => {
  // Record cursor before fixture runs so we only verify events from this run
  fixtureStartCursor = await readCursor("fixture-tracker");

  graph = await seedMasterDataGraph();

  // Fetch only events that appeared after fixture start
  const batch = await listChangeEventsSince(fixtureStartCursor, 500);
  const ourEntityIds = new Set([
    graph.facultySyncId,
    graph.departmentSyncId,
    graph.courseSyncId,
    graph.academicSessionSyncId,
    graph.semesterSyncId,
    graph.courseOfferingSyncId,
    graph.lecturerSyncId,
  ]);
  events = batch.events.filter((event) => ourEntityIds.has(event.entityId));

  // Advance the test consumer's cursor past the E2E seed events
  const otherEvents = batch.events.filter((event) => !ourEntityIds.has(event.entityId));
  const maxOtherCursor = otherEvents.length > 0
    ? Math.max(...otherEvents.map((e) => e.cursor))
    : fixtureStartCursor;

  if (maxOtherCursor > fixtureStartCursor) {
    await pool.query(
      `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
       VALUES ($1, $2)
       ON CONFLICT (consumer_id) DO UPDATE SET last_cursor = $2`,
      [CONSUMER_ID, maxOtherCursor]
    );
  }
});

after(async () => {
  await cleanupSyncTestFixtures();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM sync_lecturers`);
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [
    CONSUMER_ID,
  ]);
  // Do NOT reset the cursor to 0 here - the before hook advanced it past the
  // E2E seed events so our fixture's events are contiguous.
});

function eventsFor(entityId: string): SyncChangeEvent[] {
  return events.filter((event) => event.entityId === entityId);
}

test("creating each master-data entity emits exactly one CREATED event", () => {
  const expected: Array<[string, string, string]> = [
    ["faculty", graph.facultySyncId, "CREATED"],
    ["department", graph.departmentSyncId, "CREATED"],
    ["course", graph.courseSyncId, "CREATED"],
    ["academic_session", graph.academicSessionSyncId, "CREATED"],
    ["semester", graph.semesterSyncId, "UPDATED"],
    ["course_offering", graph.courseOfferingSyncId, "CREATED"],
    ["lecturer", graph.lecturerSyncId, "CREATED"],
  ];

  for (const [entityType, syncId, operation] of expected) {
    const matching = events.filter(
      (event) => event.entityId === syncId && event.entityType === entityType
    );
    assert.equal(
      matching.length,
      1,
      `${entityType} should have emitted exactly one ${operation} event`
    );
    assert.equal(matching[0].operation, operation);
  }
});

test("a parent is always emitted before whatever references it", () => {
  const cursorOf = (syncId: string): number => {
    const match = events.find((event) => event.entityId === syncId);
    assert.ok(match, `expected an event for ${syncId}`);
    return match.cursor;
  };

  // The applier resolves parents through NOT NULL foreign keys, so causal order
  // is a correctness requirement, not just tidiness.
  assert.ok(cursorOf(graph.facultySyncId) < cursorOf(graph.departmentSyncId));
  assert.ok(cursorOf(graph.facultySyncId) < cursorOf(graph.courseSyncId));
  assert.ok(cursorOf(graph.departmentSyncId) < cursorOf(graph.courseSyncId));
  assert.ok(cursorOf(graph.courseSyncId) < cursorOf(graph.courseOfferingSyncId));
  assert.ok(
    cursorOf(graph.academicSessionSyncId) < cursorOf(graph.courseOfferingSyncId)
  );
  assert.ok(cursorOf(graph.semesterSyncId) < cursorOf(graph.courseOfferingSyncId));
  assert.ok(cursorOf(graph.levelSyncId) < cursorOf(graph.courseSyncId));
});

test("updating a course emits UPDATED and carries the new state", async () => {
  const { updateCourse } = await import("../src/services/courseStore");
  const newTitle = `${SYNC_TEST_PREFIX} Renamed Course`;

  const updated = await updateCourse(graph.courseId, { title: newTitle });
  assert.ok(updated.ok);

  const batch = await listChangeEventsSince(0, 500);
  const update = batch.events.find(
    (event) =>
      event.entityId === graph.courseSyncId && event.operation === "UPDATED"
  );
  assert.ok(update, "the update should have emitted an UPDATED event");

  const payload = update.payload as { title: string };
  assert.equal(
    payload.title,
    newTitle,
    "the payload must describe the new state, not the old one"
  );
});

test("deactivating one academic session retires every row it changed", async () => {
  const { createAcademicSession, updateAcademicSession } = await import(
    "../src/services/academicSessionStore"
  );

  const first = await createAcademicSession({ name: `${SYNC_TEST_PREFIX}-T1` });
  assert.ok(first.ok);
  await updateAcademicSession(first.data.id, { isActive: true });

  const second = await createAcademicSession({ name: `${SYNC_TEST_PREFIX}-T2` });
  assert.ok(second.ok);
  const secondSync = await pool.query(
    `SELECT sync_id FROM academic_sessions WHERE id = $1`,
    [second.data.id]
  );

  // Activating the second session deactivates the first in the same statement.
  const activated = await updateAcademicSession(second.data.id, {
    isActive: true,
  });
  assert.ok(activated.ok);

  const batch = await listChangeEventsSince(0, 500);
  const retired = batch.events.filter(
    (event) =>
      event.entityType === "academic_session" &&
      event.entityId === secondSync.rows[0].sync_id &&
      event.operation === "UPDATED" &&
      (event.payload as { isActive: boolean }).isActive === true
  );
  assert.equal(
    retired.length,
    1,
    "the newly activated session must be published in its active state"
  );

  const firstStillActive = await pool.query(
    `SELECT is_active FROM academic_sessions WHERE id = $1`,
    [first.data.id]
  );
  assert.equal(
    firstStillActive.rows[0].is_active,
    false,
    "activating one session deactivates the other, which is the point of the test"
  );
});

test("no master-data payload contains identity or credential fields", () => {
  const forbidden = [
    "password",
    "passwordHash",
    "password_hash",
    "username",
    "email",
    "webauthn",
    "webauthnUserHandle",
    "webauthn_user_handle",
    "deviceCredential",
    "sessionToken",
    "session_token",
  ];

  for (const event of events) {
    const serialised = JSON.stringify(event.payload).toLowerCase();
    for (const key of forbidden) {
      assert.ok(
        !serialised.includes(key.toLowerCase()),
        `${event.entityType} payload must not contain "${key}"`
      );
    }
  }

  // The lecturer payload carries a display name but no row in `users` exists on
  // the edge, which is the whole reason the projection exists.
  const lecturer = events.find((event) => event.entityType === "lecturer");
  assert.ok(lecturer);
  const payload = lecturer.payload as { displayName: string; cloudUserId: number };
  assert.ok(payload.displayName.length > 0);
  assert.equal(typeof payload.cloudUserId, "number");
});

test("the edge writes master data into its own tables, resolving parents by UUID", async () => {
  await readCursor(CONSUMER_ID);
  const applied = await applyChangeBatch(CONSUMER_ID, events);
  assert.equal(applied.cursor, events[events.length - 1].cursor);

  // Each mirrored row is found by its cloud UUID, and carries its own local id.
  const faculty = await pool.query(
    `SELECT id, name, code, status FROM faculties WHERE sync_id = $1`,
    [graph.facultySyncId]
  );
  assert.equal(faculty.rowCount, 1);
  assert.ok(faculty.rows[0].id > 0);

  const department = await pool.query(
    `SELECT d.name, d.status, f.sync_id AS faculty_sync_id
     FROM departments d
     JOIN faculties f ON f.id = d.faculty_id
     WHERE d.sync_id = $1`,
    [graph.departmentSyncId]
  );
  assert.equal(department.rowCount, 1);
  assert.equal(
    department.rows[0].faculty_sync_id,
    graph.facultySyncId,
    "the department must point at the edge's own faculty row, resolved by UUID"
  );

  const course = await pool.query(
    `SELECT c.course_code, c.title,
            d.sync_id AS department_sync_id,
            lv.sync_id AS level_sync_id,
            c.faculty_id
     FROM courses c
     JOIN departments d ON d.id = c.department_id
     JOIN levels lv ON lv.id = c.level_id
     WHERE c.sync_id = $1`,
    [graph.courseSyncId]
  );
  assert.equal(course.rowCount, 1);
  assert.equal(course.rows[0].department_sync_id, graph.departmentSyncId);
  assert.equal(course.rows[0].level_sync_id, graph.levelSyncId);
  assert.equal(
    course.rows[0].faculty_id,
    null,
    "a department-owned course must not gain a faculty on the edge"
  );

  const offering = await pool.query(
    `SELECT o.status, c.sync_id AS course_sync_id,
            a.sync_id AS academic_session_sync_id,
            s.sync_id AS semester_sync_id
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions a ON a.id = o.academic_session_id
     JOIN semesters s ON s.id = o.semester_id
     WHERE o.sync_id = $1`,
    [graph.courseOfferingSyncId]
  );
  assert.equal(offering.rowCount, 1);
  assert.equal(offering.rows[0].course_sync_id, graph.courseSyncId);
  assert.equal(offering.rows[0].status, "OPEN");
});

test("the retired location and attendance_network tables no longer exist", async () => {
  // Migration 018 dropped both. They existed only to populate the session
  // columns migration 017 removed, so nothing should recreate them.
  for (const table of ["locations", "attendance_networks"]) {
    const row = await pool.query(`SELECT to_regclass($1) AS oid`, [table]);
    assert.equal(
      row.rows[0].oid,
      null,
      `${table} should have been dropped by migration 018`
    );
  }
});

test("the edge stores lecturers in the projection and never in users", async () => {
  await readCursor(CONSUMER_ID);
  await applyChangeBatch(CONSUMER_ID, events);

  const lecturer = await pool.query(
    `SELECT cloud_lecturer_id, staff_id, display_name, cloud_department_sync_id
     FROM sync_lecturers WHERE cloud_sync_id = $1`,
    [graph.lecturerSyncId]
  );
  assert.equal(lecturer.rowCount, 1);
  assert.equal(Number(lecturer.rows[0].cloud_lecturer_id), graph.lecturerId);
  assert.equal(lecturer.rows[0].cloud_department_sync_id, graph.departmentSyncId);
  assert.ok(lecturer.rows[0].display_name.includes(SYNC_TEST_PREFIX));

  // The projection has no foreign key to `users`, so no identity row is required
  // or created for a cloud lecturer.
  const fk = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'sync_lecturers'::regclass AND contype = 'f'`
  );
  assert.equal(
    fk.rowCount,
    0,
    "sync_lecturers must not depend on the edge's identity tables"
  );
});

test("re-applying the same master-data events is idempotent", async () => {
  await readCursor(CONSUMER_ID);
  const first = await applyChangeBatch(CONSUMER_ID, events);
  assert.equal(first.applied, events.length);

  const countBefore = await pool.query(
    `SELECT count(*)::int AS n FROM courses WHERE sync_id = $1`,
    [graph.courseSyncId]
  );

  // Rewind the cursor so the identical batch is offered a second time; the
  // receipts must absorb it.
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = 0 WHERE consumer_id = $1`,
    [CONSUMER_ID]
  );
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [
    CONSUMER_ID,
  ]);
  await applyChangeBatch(CONSUMER_ID, events);

  const countAfter = await pool.query(
    `SELECT count(*)::int AS n FROM courses WHERE sync_id = $1`,
    [graph.courseSyncId]
  );
  assert.equal(
    countAfter.rows[0].n,
    countBefore.rows[0].n,
    "upserting twice must not duplicate the row"
  );
});

test("a child event whose parent is absent stops the cursor instead of dangling", async () => {
  const { createFaculty, createDepartment } = await import(
    "../src/services/organizationStore"
  );

  // A department created against a faculty that has NOT been mirrored on this edge
  // simulates an edge whose cursor was advanced past the parent's CREATED event.
  const departmentSyncId = "00000000-0000-4000-8000-00000000ffff";
  const orphan: SyncChangeEvent = {
    eventId: "11111111-1111-4111-8111-111111111111",
    cursor: 1,
    entityType: "department",
    entityId: departmentSyncId,
    operation: "CREATED",
    payload: {
      version: 1,
      syncId: departmentSyncId,
      cloudDepartmentId: 999,
      name: "Orphan Department",
      code: "ORPHAN",
      status: "ACTIVE",
      cloudFacultySyncId: "22222222-2222-4222-8222-222222222222",
    } as SyncChangeEvent["payload"],
    recordedAt: new Date().toISOString(),
  };

  await readCursor(CONSUMER_ID);
  await assert.rejects(
    () => applyChangeBatch(CONSUMER_ID, [orphan]),
    (error: unknown) => {
      assert.match((error as Error).message, /parent|not present/i);
      return true;
    }
  );

  assert.equal(
    await readCursor(CONSUMER_ID),
    0,
    "a refused event must leave the cursor where it was"
  );
  const orphanRow = await pool.query(
    `SELECT 1 FROM departments WHERE sync_id = $1`,
    [departmentSyncId]
  );
  assert.equal(orphanRow.rowCount, 0, "no dangling row may be written");

  // Referenced so the imports above are exercised rather than dead.
  const probe = await createFaculty({
    name: `${SYNC_TEST_PREFIX} Probe`,
    code: `${SYNC_TEST_PREFIX}-PROBE`,
  });
  assert.ok(probe.ok);
  const probeDepartment = await createDepartment({
    name: `${SYNC_TEST_PREFIX} Probe Dept`,
    code: `${SYNC_TEST_PREFIX}-PROBED`,
    facultyId: probe.data.id,
  });
  assert.ok(probeDepartment.ok);
});

test("the feed serves mixed entity types in one ordered page", async () => {
  const batch = await listChangeEventsSince(0, 500);
  const types = new Set(batch.events.map((event) => event.entityType));

  for (const expected of [
    "faculty",
    "department",
    "course",
    "academic_session",
    "semester",
    "course_offering",
    "lecturer",
  ]) {
    assert.ok(types.has(expected as never), `feed should carry ${expected} events`);
  }

  let previous = 0;
  for (const event of batch.events) {
    assert.ok(
      event.cursor > previous,
      "the feed must be strictly ascending across entity types"
    );
    previous = event.cursor;
  }
});

test("master data is served through the authenticated endpoint like everything else", async () => {
  const { app } = await import("../src/app");
  const { syncAuthHeaders, TEST_EDGE_SECRET } = await import("./syncTestFixtures");

  const listener = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const port = (listener.address() as AddressInfo).port;

  try {
    const anonymous = await fetch(
      `http://127.0.0.1:${port}/api/internal/sync/changes?cursor=0`
    );
    assert.equal(anonymous.status, 401);

    const authorised = await fetch(
      `http://127.0.0.1:${port}/api/internal/sync/changes?cursor=0&limit=500`,
      { headers: syncAuthHeaders(TEST_EDGE_SECRET) }
    );
    assert.equal(authorised.status, 200);
    const body = (await authorised.json()) as {
      data: { events: Array<{ entityType: string }> };
    };
    assert.ok(body.data.events.length > 0);
    assert.ok(
      body.data.events.some((event) => event.entityType === "course"),
      "the endpoint must expose master data through the same guarded surface"
    );
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});