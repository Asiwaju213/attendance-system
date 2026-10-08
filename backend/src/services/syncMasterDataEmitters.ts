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
function missing(entity: string, id: number | string): Error {
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

/**
 * Publish one cloud student.
 *
 * The row is read back through the join the edge will write, so the payload
 * always describes what is actually stored: `students.sync_id` is the
 * cross-database identity, and the name/status come from the `users` row the
 * student points at.
 *
 * Only the columns the edge replicates are selected. `password_hash`,
 * `username`, `students.webauthn_user_handle` and every `student_devices`
 * column are neither read nor transmitted, so no authentication material can
 * enter the feed even if a later column is added to one of those tables.
 */
export async function appendStudentEvent(
  client: PoolClient,
  operation: SyncOperation,
  studentId: number
): Promise<void> {
  const result = await client.query(
    `SELECT s.id, s.sync_id, s.matric_number,
            u.name, u.status,
            d.sync_id AS department_sync_id,
            lv.sync_id AS level_sync_id
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN departments d ON d.id = s.department_id
     JOIN levels lv ON lv.id = s.level_id
     WHERE s.id = $1`,
    [studentId]
  );
  const row = result.rows[0];
  if (!row) throw missing("student", studentId);

  await appendChangeEvent(client, "student", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudStudentId: Number(row.id),
    matricNumber: row.matric_number,
    name: row.name,
    // Narrowed to the three values migration 005 leaves `users.status` with, so
    // an unexpected database value becomes a type error rather than a payload
    // the edge's CHECK constraint would reject.
    status: row.status as "ACTIVE" | "INACTIVE" | "PENDING",
    cloudDepartmentSyncId: row.department_sync_id,
    cloudLevelSyncId: row.level_sync_id,
  });
}

/**
 * Publish one cloud course registration.
 *
 * The row is read back through the joins the edge writes, so the payload
 * always describes what is actually stored: `course_registrations.sync_id` is
 * the cross-database identity, the two parents are their own `sync_id` UUIDs
 * (which the edge resolves against its mirrored `students` and
 * `course_offerings` rows), and the status comes from the row rather than from
 * the caller's intent.
 *
 * Only those columns are selected. A registration row holds no credential and
 * no student profile beyond the parent reference - no matric number, no name,
 * no password or device material - so nothing of that shape can enter the feed
 * even if a column is added to the table later.
 */
export async function appendCourseRegistrationEvent(
  client: PoolClient,
  operation: SyncOperation,
  courseRegistrationId: number
): Promise<void> {
  const result = await client.query(
    `SELECT r.id, r.sync_id, r.status,
            s.sync_id AS student_sync_id,
            o.sync_id AS offering_sync_id
     FROM course_registrations r
     JOIN students s ON s.id = r.student_id
     JOIN course_offerings o ON o.id = r.course_offering_id
     WHERE r.id = $1`,
    [courseRegistrationId]
  );
  const row = result.rows[0];
  if (!row) throw missing("course registration", courseRegistrationId);

  await appendChangeEvent(client, "course_registration", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudRegistrationId: Number(row.id),
    cloudStudentSyncId: row.student_sync_id,
    cloudCourseOfferingSyncId: row.offering_sync_id,
    // Narrowed to the three values the `course_registrations` CHECK constraint
    // admits, so an unexpected database value is a type error rather than a
    // payload the edge would refuse after it had already been published.
    status: row.status as "ENROLLED" | "DROPPED" | "COMPLETED",
  });
}

/**
 * Publish one cloud device-state change.
 *
 * The row is read back through the join the edge writes, so the payload always
 * describes what is actually stored: `student_devices.sync_id` is the
 * cross-database identity of the row, `student_devices.device_ref` is the
 * device's opaque stable reference (what a binding cookie carries), and the
 * status comes from the row rather than from the caller's intent.
 *
 * Only those columns are selected. A device row holds the credential - id,
 * public key, counter, transports, AAGUID, discoverable flag - and none of it
 * is read here, so no authentication material can enter the feed even if a
 * column is added to the table later. The payload is identity, parent and
 * status, and nothing else.
 */
export async function appendStudentDeviceEvent(
  client: PoolClient,
  operation: SyncOperation,
  studentDeviceId: number
): Promise<void> {
  const result = await client.query(
    `SELECT d.id, d.sync_id, d.device_ref, d.status,
            s.sync_id AS student_sync_id
     FROM student_devices d
     JOIN students s ON s.id = d.student_id
     WHERE d.id = $1`,
    [studentDeviceId]
  );
  const row = result.rows[0];
  if (!row) throw missing("student device", studentDeviceId);

  await appendChangeEvent(client, "student_device", row.sync_id, operation, {
    version: SYNC_PAYLOAD_VERSION,
    syncId: row.sync_id,
    cloudDeviceRef: row.device_ref,
    cloudStudentSyncId: row.student_sync_id,
    // Narrowed to the two values the `student_devices` CHECK constraint admits,
    // so an unexpected database value is a type error rather than a payload the
    // edge would refuse after it had already been published.
    status: row.status as "ACTIVE" | "REVOKED",
  });
}

/**
 * Publish one one-time device bootstrap secret (hash only).
 *
 * Called in the same transaction that mints the secret, so the feed event and
 * the row it describes commit together: there is never a published bootstrap
 * without a row, nor a row the edge will not eventually see.
 *
 * The payload carries `secret_hash` - the SHA-256 hex digest - and never the
 * plaintext. The plaintext exists only in the enrollment response body; it is
 * not a column of this table, not an argument to this function, and not
 * selectable here even by accident, because the join below lists every column
 * it reads. What crosses the boundary is enough for the edge to recognize the
 * secret the student spends, and no more.
 */
export async function appendStudentDeviceBootstrapEvent(
  client: PoolClient,
  operation: SyncOperation,
  bootstrapSyncId: string
): Promise<void> {
  const result = await client.query(
    `SELECT b.sync_id, b.secret_hash, b.status, b.expires_at,
            d.device_ref, s.sync_id AS student_sync_id
     FROM student_device_bootstraps b
     JOIN student_devices d ON d.id = b.device_id
     JOIN students s ON s.id = b.student_id
     WHERE b.sync_id = $1`,
    [bootstrapSyncId]
  );
  const row = result.rows[0];
  if (!row) throw missing("student device bootstrap", bootstrapSyncId);

  await appendChangeEvent(
    client,
    "student_device_bootstrap",
    row.sync_id,
    operation,
    {
      version: SYNC_PAYLOAD_VERSION,
      syncId: row.sync_id,
      cloudDeviceRef: row.device_ref,
      cloudStudentSyncId: row.student_sync_id,
      // SHA-256 hex of the secret. Never the secret itself: the cloud stores no
      // other form, so there is nothing else this read could have selected.
      secretHash: row.secret_hash,
      // Narrowed to the two values the `student_device_bootstraps` CHECK
      // constraint admits. The cloud only ever mints PENDING rows; CONSUMED is
      // carried by the type so a future re-emission cannot be a type error.
      status: row.status as "PENDING" | "CONSUMED",
      expiresAt: row.expires_at.toISOString(),
    }
  );
}