import type { PoolClient } from "pg";
import { SYNC_PAYLOAD_VERSION } from "../config/sync";
import type { SyncOperation } from "../types/sync";
import { appendChangeEvent } from "./syncChangeEventStore";

/**
 * Emits change events for cloud-owned master data.
 *
 * Each function reads the committed-shape row back inside the caller's
 * transaction (joining whatever parent it needs), builds the payload, and appends
 * the event on that same client. Reading the row back rather than assembling the
 * payload from the caller's inputs is deliberate: the payload then always
 * describes what is actually in the database, including database defaults,
 * triggers and anything a CHECK constraint coerced. Assembling it from inputs
 * would let the feed disagree with the row.
 *
 * Every payload is built from an explicit column list. Nothing here selects `*`,
 * so adding a sensitive column to one of these tables later cannot silently
 * start publishing it.
 */

/** Thrown when a row that should exist cannot be read back. */
function missing(entity: string, id: number): Error {
  return new Error(
    `Cannot synchronize ${entity} ${id}: the row could not be read back inside the transaction.`
  );
}

export async function appendFacultyEvent(
  client: PoolClient,
  operation: SyncOperation,
  facultyId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, name, code, status FROM faculties WHERE id = $1`,
    [facultyId]
  );
  const row = result.rows[0];
  if (!row) throw missing("faculty", facultyId);

  await appendChangeEvent(client, "faculty", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudFacultyId: Number(row.id),
    name: row.name,
    code: row.code,
    status: row.status,
  });
}

export async function appendDepartmentEvent(
  client: PoolClient,
  operation: SyncOperation,
  departmentId: number
): Promise<void> {
  const result = await client.query(
    `SELECT d.id, d.sync_id, d.name, d.code, d.status,
            f.sync_id AS faculty_sync_id
     FROM departments d
     JOIN faculties f ON f.id = d.faculty_id
     WHERE d.id = $1`,
    [departmentId]
  );
  const row = result.rows[0];
  if (!row) throw missing("department", departmentId);

  await appendChangeEvent(client, "department", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudDepartmentId: Number(row.id),
    name: row.name,
    code: row.code,
    status: row.status,
    cloudFacultySyncId: row.faculty_sync_id,
  });
}

export async function appendLevelEvent(
  client: PoolClient,
  operation: SyncOperation,
  levelId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, name FROM levels WHERE id = $1`,
    [levelId]
  );
  const row = result.rows[0];
  if (!row) throw missing("level", levelId);

  await appendChangeEvent(client, "level", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudLevelId: Number(row.id),
    name: Number(row.name),
  });
}

export async function appendCourseEvent(
  client: PoolClient,
  operation: SyncOperation,
  courseId: number
): Promise<void> {
  // The LEFT JOINs are required: a course belongs to a faculty OR a department,
  // never both, so one of these is always NULL and an inner join would drop the
  // row entirely.
  const result = await client.query(
    `SELECT c.id, c.sync_id, c.course_code, c.title, c.status,
            d.sync_id AS department_sync_id,
            f.sync_id AS faculty_sync_id,
            lv.sync_id AS level_sync_id
     FROM courses c
     LEFT JOIN departments d ON d.id = c.department_id
     LEFT JOIN faculties f ON f.id = c.faculty_id
     JOIN levels lv ON lv.id = c.level_id
     WHERE c.id = $1`,
    [courseId]
  );
  const row = result.rows[0];
  if (!row) throw missing("course", courseId);

  await appendChangeEvent(client, "course", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudCourseId: Number(row.id),
    courseCode: row.course_code,
    title: row.title,
    status: row.status,
    cloudDepartmentSyncId: row.department_sync_id ?? null,
    cloudFacultySyncId: row.faculty_sync_id ?? null,
    cloudLevelSyncId: row.level_sync_id,
  });
}

export async function appendAcademicSessionEvent(
  client: PoolClient,
  operation: SyncOperation,
  academicSessionId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, name, is_active FROM academic_sessions WHERE id = $1`,
    [academicSessionId]
  );
  const row = result.rows[0];
  if (!row) throw missing("academic session", academicSessionId);

  await appendChangeEvent(client, "academic_session", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudAcademicSessionId: Number(row.id),
    name: row.name,
    isActive: row.is_active,
  });
}

export async function appendSemesterEvent(
  client: PoolClient,
  operation: SyncOperation,
  semesterId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, name FROM semesters WHERE id = $1`,
    [semesterId]
  );
  const row = result.rows[0];
  if (!row) throw missing("semester", semesterId);

  await appendChangeEvent(client, "semester", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudSemesterId: Number(row.id),
    name: row.name,
  });
}

export async function appendCourseOfferingEvent(
  client: PoolClient,
  operation: SyncOperation,
  courseOfferingId: number
): Promise<void> {
  const result = await client.query(
    `SELECT o.id, o.sync_id, o.status,
            c.sync_id AS course_sync_id,
            a.sync_id AS academic_session_sync_id,
            s.sync_id AS semester_sync_id
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions a ON a.id = o.academic_session_id
     JOIN semesters s ON s.id = o.semester_id
     WHERE o.id = $1`,
    [courseOfferingId]
  );
  const row = result.rows[0];
  if (!row) throw missing("course offering", courseOfferingId);

  await appendChangeEvent(client, "course_offering", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudCourseOfferingId: Number(row.id),
    status: row.status,
    cloudCourseSyncId: row.course_sync_id,
    cloudAcademicSessionSyncId: row.academic_session_sync_id,
    cloudSemesterSyncId: row.semester_sync_id,
  });
}

export async function appendLocationEvent(
  client: PoolClient,
  operation: SyncOperation,
  locationId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, name, description, status FROM locations WHERE id = $1`,
    [locationId]
  );
  const row = result.rows[0];
  if (!row) throw missing("location", locationId);

  await appendChangeEvent(client, "location", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudLocationId: Number(row.id),
    name: row.name,
    description: row.description ?? null,
    status: row.status,
  });
}

export async function appendAttendanceNetworkEvent(
  client: PoolClient,
  operation: SyncOperation,
  networkId: number
): Promise<void> {
  const result = await client.query(
    `SELECT id, sync_id, network_code, name, status
     FROM attendance_networks WHERE id = $1`,
    [networkId]
  );
  const row = result.rows[0];
  if (!row) throw missing("attendance network", networkId);

  await appendChangeEvent(client, "attendance_network", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudAttendanceNetworkId: Number(row.id),
    networkCode: row.network_code,
    name: row.name,
    status: row.status,
  });
}

/**
 * A lecturer event carries only the lecturer's public staff identity.
 *
 * `users.name` is read because a synchronized session has to be attributable, and
 * the edge has no row of its own in `users` to join to. `password_hash`,
 * `username` and every credential column are neither selected nor transmitted.
 */
export async function appendLecturerEvent(
  client: PoolClient,
  operation: SyncOperation,
  lecturerId: number
): Promise<void> {
  const result = await client.query(
    `SELECT lec.id, lec.sync_id, lec.staff_id, lec.user_id,
            u.name AS display_name,
            d.sync_id AS department_sync_id
     FROM lecturers lec
     JOIN users u ON u.id = lec.user_id
     LEFT JOIN departments d ON d.id = lec.department_id
     WHERE lec.id = $1`,
    [lecturerId]
  );
  const row = result.rows[0];
  if (!row) throw missing("lecturer", lecturerId);

  await appendChangeEvent(client, "lecturer", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudLecturerId: Number(row.id),
    staffId: row.staff_id,
    displayName: row.display_name,
    cloudUserId: Number(row.user_id),
    cloudDepartmentSyncId: row.department_sync_id ?? null,
  });
}