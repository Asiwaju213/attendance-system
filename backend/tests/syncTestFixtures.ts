import { createHash } from "node:crypto";

/**
 * Shared fixtures for the synchronization tests.
 *
 * This module has a side effect on purpose and MUST be the first import in any
 * test file that needs the sync feed endpoint: it sets the provider credential
 * before `config/sync` is ever evaluated. Module side effects run in import
 * order, so importing this line above `import { app } from "../src/app"` is what
 * makes the configured hash take effect.
 *
 * The digest is computed here with plain `node:crypto` rather than by importing
 * the application's own `hashEdgeSecret`. That is intentional: a test that reused
 * the function under test could pass even if that function were wrong.
 */

export const TEST_EDGE_SECRET = "sync-edge-secret-for-backend-tests-only";
export const TEST_CONSUMER_ID = "test-k12-edge";

process.env.SYNC_PROVIDER_SECRET_HASH = createHash("sha256")
  .update(TEST_EDGE_SECRET, "utf8")
  .digest("hex");

export function syncAuthHeaders(secret: string = TEST_EDGE_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

/** Prefix used by every row this helper creates, so cleanup is unambiguous. */
export const SYNC_TEST_PREFIX = `SYNCFEED-${Date.now().toString(36)}`;

let counter = 0;

function unique(suffix: string): string {
  counter += 1;
  return `${SYNC_TEST_PREFIX}-${suffix}-${counter}`;
}

async function insert(
  sql: string,
  params: unknown[] = []
): Promise<number> {
  const { pool } = await import("../src/db/pool");
  const result = await pool.query(sql, params);
  return Number(result.rows[0].id);
}

/**
 * Minimal, self-contained lecturer session fixture.
 *
 * Deliberately does not reuse any other test file's seeding: this suite must be
 * runnable on its own, and the attendance-session lifecycle needs exactly one
 * lecturer and one offering.
 */
export async function seedLecturerSessionFixture(): Promise<{
  userId: number;
  sessionToken: string;
  courseOfferingId: number;
}> {
  const { pool } = await import("../src/db/pool");
  const { hashPassword } = await import("../src/lib/passwords");
  const { hashSessionToken } = await import("../src/lib/sessions");
  const { createSession } = await import("../src/services/sessionStore");

  // Migration 004 links every department to exactly one faculty and made
  // faculty_id NOT NULL, so a faculty has to exist before a department.
  const facultyId = await insert(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    [`${SYNC_TEST_PREFIX} Faculty`, unique("FAC")]
  );

  const departmentId = await insert(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${SYNC_TEST_PREFIX} Department`, unique("DEPT"), facultyId]
  );

  const levelResult = await pool.query(
    `SELECT id FROM levels WHERE name = 100 LIMIT 1`
  );
  const levelId = Number(levelResult.rows[0].id);

  const academicSessionId = await insert(
    `INSERT INTO academic_sessions (name, is_active) VALUES ($1, true) RETURNING id`,
    [unique("ACAD")]
  );

  const semesterResult = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester' LIMIT 1`
  );
  const semesterId = Number(semesterResult.rows[0].id);

  const courseId = await insert(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [unique("CRS"), `${SYNC_TEST_PREFIX} Course`, departmentId, levelId]
  );

  const courseOfferingId = await insert(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'OPEN') RETURNING id`,
    [courseId, academicSessionId, semesterId]
  );

  const userId = await insert(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'LECTURER', 'ACTIVE') RETURNING id`,
    [`${SYNC_TEST_PREFIX} Lecturer`, await hashPassword("sync-feed-test-password")]
  );

  const lecturerId = await insert(
    `INSERT INTO lecturers (user_id, staff_id, department_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, unique("STAFF"), departmentId]
  );

  await insert(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2) RETURNING id`,
    [courseOfferingId, lecturerId]
  );

  const sessionToken = "sync-feed-test-session-token";
  await createSession(
    userId,
    hashSessionToken(sessionToken),
    new Date(Date.now() + 3_600_000)
  );

  return {
    userId,
    sessionToken,
    courseOfferingId,
  };
}

/**
 * A complete master-data graph, created through the real store functions so the
 * change events they emit are the ones under test.
 *
 * Returns the cloud ids and the `sync_id` of every row, which is what the local
 * applier resolves against.
 */
export async function seedMasterDataGraph(): Promise<{
  facultyId: number;
  facultySyncId: string;
  departmentId: number;
  departmentSyncId: string;
  levelId: number;
  levelSyncId: string;
  courseId: number;
  courseSyncId: string;
  academicSessionId: number;
  academicSessionSyncId: string;
  semesterId: number;
  semesterSyncId: string;
  courseOfferingId: number;
  courseOfferingSyncId: string;
  lecturerId: number;
  lecturerSyncId: string;
}> {
  const { createFaculty, createDepartment } = await import(
    "../src/services/organizationStore"
  );
  const { createCourse } = await import("../src/services/courseStore");
  const { createAcademicSession } = await import(
    "../src/services/academicSessionStore"
  );
  
  const { createOffering } = await import("../src/services/courseOfferingStore");
  const { appendLevelEvent, appendSemesterEvent } = await import(
    "../src/services/syncMasterDataEmitters"
  );

  const { pool } = await import("../src/db/pool");

  // Named separately so the import above reads as intentional rather than as a
  // loop variable shadowing an unrelated function.
  const appendSemesterEventForTest = appendSemesterEvent;

  const faculty = await createFaculty({
    name: `${SYNC_TEST_PREFIX} Master Faculty`,
    code: unique("MFAC"),
  });
  if (!faculty.ok) throw new Error(`createFaculty failed: ${faculty.code}`);

  const department = await createDepartment({
    name: `${SYNC_TEST_PREFIX} Master Department`,
    code: unique("MDEPT"),
    facultyId: faculty.data.id,
  });
  if (!department.ok) throw new Error(`createDepartment failed: ${department.code}`);

  // `levels` is seeded by migration and is never created at runtime, so the
  // existing level 100 row is reused.
  const level = await pool.query(`SELECT id, sync_id FROM levels WHERE name = 100`);
  const levelId = Number(level.rows[0].id);
  const levelSyncId = level.rows[0].sync_id as string;

  // No runtime path creates a level, so there is no CREATED event to observe for
  // one. Publishing the existing row directly, exactly like the semester below,
  // keeps the "parent before child" ordering test meaningful for the course that
  // references this level.
  const levelClient = await pool.connect();
  try {
    await levelClient.query("BEGIN");
    await appendLevelEvent(levelClient, "UPDATED", levelId);
    await levelClient.query("COMMIT");
  } catch (error) {
    await levelClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    levelClient.release();
  }

  const academicSession = await createAcademicSession({
    name: unique("MACAD"),
  });
  if (!academicSession.ok) {
    throw new Error(`createAcademicSession failed: ${academicSession.code}`);
  }

  // `semesters.name` is constrained to two literals and migration-seeded rows
  // already exist, so the existing one is reused rather than created. Attempting
  // to create it would fail with CONFLICT and emit no event.
  const existingSemester = await pool.query(
    `SELECT id, sync_id FROM semesters WHERE name = 'First Semester' LIMIT 1`
  );
  const semesterId = Number(existingSemester.rows[0].id);
  const semesterSyncId = existingSemester.rows[0].sync_id as string;

  // No runtime path creates a semester, so there is no CREATED event to observe
  // for one. Publishing the existing row directly still exercises the semester
  // applier and its position in the parent ordering.
  const semesterClient = await pool.connect();
  try {
    await semesterClient.query("BEGIN");
    await appendSemesterEventForTest(semesterClient, "UPDATED", semesterId);
    await semesterClient.query("COMMIT");
  } catch (error) {
    await semesterClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    semesterClient.release();
  }

  const course = await createCourse({
    courseCode: unique("MCRS"),
    title: `${SYNC_TEST_PREFIX} Master Course`,
    levelId,
    departmentId: department.data.id,
  });
  if (!course.ok) throw new Error(`createCourse failed: ${course.code}`);

  const offering = await createOffering({
    courseId: course.data.id,
    academicSessionId: academicSession.data.id,
    semesterId,
  });
  if (!offering.ok) throw new Error(`createOffering failed: ${offering.code}`);

  // Lecturer identity is created directly because the application has no runtime
  // path for it; the event is emitted the same way the seeder does it.
  const { hashPassword } = await import("../src/lib/passwords");
  const { appendLecturerEvent } = await import(
    "../src/services/syncMasterDataEmitters"
  );
  const userId = await insert(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'LECTURER', 'ACTIVE') RETURNING id`,
    [
      `${SYNC_TEST_PREFIX} Master Lecturer`,
      await hashPassword("sync-master-data-test-password"),
    ]
  );
  const { pool: lecturerPool } = await import("../src/db/pool");
  const lecturerRow = await lecturerPool.query(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)
     RETURNING id, sync_id`,
    [userId, unique("MSTAFF"), department.data.id]
  );
  const lecturerId = Number(lecturerRow.rows[0].id);
  const lecturerSyncId = lecturerRow.rows[0].sync_id as string;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await appendLecturerEvent(client, "CREATED", lecturerId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const syncId = async (table: string, id: number): Promise<string> => {
    const row = await pool.query(`SELECT sync_id FROM ${table} WHERE id = $1`, [id]);
    return row.rows[0].sync_id as string;
  };

  return {
    facultyId: faculty.data.id,
    facultySyncId: await syncId("faculties", faculty.data.id),
    departmentId: department.data.id,
    departmentSyncId: await syncId("departments", department.data.id),
    levelId,
    levelSyncId,
    courseId: course.data.id,
    courseSyncId: await syncId("courses", course.data.id),
    academicSessionId: academicSession.data.id,
    academicSessionSyncId: await syncId("academic_sessions", academicSession.data.id),
    semesterId,
    semesterSyncId,
    courseOfferingId: offering.data.id,
    courseOfferingSyncId: await syncId("course_offerings", offering.data.id),
    lecturerId,
    lecturerSyncId,
  };
}

export async function cleanupSyncTestFixtures(): Promise<void> {
  const { pool } = await import("../src/db/pool");

  // Order matters: children before parents, because every foreign key in this
  // schema is ON DELETE RESTRICT.
  //
  // `NOT IN (SELECT sync_id ...)` is replaced by an explicit NOT EXISTS, because
  // `NOT IN` against a subquery that returns a NULL yields no rows at all and
  // would silently delete nothing.
  await pool.query(
    `DELETE FROM sync_change_events e
     WHERE NOT EXISTS (
       SELECT 1 FROM attendance_sessions s WHERE s.sync_id::text = e.entity_id
     )`
  );
  await pool.query(`DELETE FROM sync_lecturers`);
  await pool.query(`DELETE FROM sync_attendance_sessions`);
  await pool.query(`DELETE FROM sync_processed_events`);
  await pool.query(`DELETE FROM sync_consumer_state`);

  await pool.query(
    `DELETE FROM audit_logs
     WHERE description LIKE '%${SYNC_TEST_PREFIX}%' OR action IN ('SESSION_STARTED', 'SESSION_ENDED')
       AND user_id IN (SELECT id FROM users WHERE name LIKE '${SYNC_TEST_PREFIX}%')`
  );

  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE course_offering_id IN (
       SELECT co.id FROM course_offerings co
       JOIN courses c ON c.id = co.course_id
       WHERE c.course_code LIKE '${SYNC_TEST_PREFIX}-CRS-%'
          OR c.course_code LIKE '${SYNC_TEST_PREFIX}-MCRS-%'
     )`
  );

  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT co.id FROM course_offerings co
       JOIN courses c ON c.id = co.course_id
       WHERE c.course_code LIKE '${SYNC_TEST_PREFIX}-CRS-%'
          OR c.course_code LIKE '${SYNC_TEST_PREFIX}-MCRS-%'
     )`
  );

  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE '${SYNC_TEST_PREFIX}-CRS-%'
                         OR course_code LIKE '${SYNC_TEST_PREFIX}-MCRS-%')`
  );
  await pool.query(
    `DELETE FROM courses WHERE course_code LIKE '${SYNC_TEST_PREFIX}-CRS-%'
                            OR course_code LIKE '${SYNC_TEST_PREFIX}-MCRS-%'`
  );

  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE name LIKE '${SYNC_TEST_PREFIX}%')`
  );
  await pool.query(
    `DELETE FROM lecturers WHERE staff_id LIKE '${SYNC_TEST_PREFIX}-STAFF-%'
                             OR staff_id LIKE '${SYNC_TEST_PREFIX}-MSTAFF-%'`
  );
  await pool.query(`DELETE FROM users WHERE name LIKE '${SYNC_TEST_PREFIX}%'`);

  await pool.query(
    `DELETE FROM academic_sessions WHERE name LIKE '${SYNC_TEST_PREFIX}-ACAD-%'
                                     OR name LIKE '${SYNC_TEST_PREFIX}-MACAD-%'`
  );
  await pool.query(
    `DELETE FROM departments WHERE code LIKE '${SYNC_TEST_PREFIX}-DEPT-%'
                                OR code LIKE '${SYNC_TEST_PREFIX}-MDEPT-%'`
  );
  await pool.query(
    `DELETE FROM faculties WHERE code LIKE '${SYNC_TEST_PREFIX}-FAC-%'
                              OR code LIKE '${SYNC_TEST_PREFIX}-MFAC-%'`
  );
}