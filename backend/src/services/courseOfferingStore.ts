import { pool } from "../db/pool";
import { appendCourseOfferingEvent } from "./syncMasterDataEmitters";
import {
  AssignedLecturer,
  CourseOffering,
  CourseOfferingRegistrations,
  OfferingForLecturer,
  OfferingStatus,
  RegistrationRosterItem,
  RegistrationStatus,
} from "../types/courseOffering";
import { OrganizationStatus } from "../types/organization";
import { Role } from "../types/auth";
import {
  AssignLecturerInput,
  OfferingCreateInput,
  OfferingListFilters,
  OfferingUpdateInput,
  RegistrationListFilters,
} from "../validation/adminCourseOfferingValidation";

export type OfferingErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "COURSE_NOT_FOUND"
  | "COURSE_NOT_ACTIVE"
  | "ACADEMIC_SESSION_NOT_FOUND"
  | "SEMESTER_NOT_FOUND"
  | "HAS_REGISTRATIONS"
  | "HAS_ATTENDANCE"
  | "LECTURER_NOT_FOUND"
  | "NOT_A_LECTURER"
  | "LECTURER_NOT_ACTIVE"
  | "ALREADY_ASSIGNED"
  | "NOT_ASSIGNED"
  | "INVALID_STATUS"
  | "INVALID_PAGINATION"
  | "STUDENT_NOT_FOUND"
  | "STUDENT_NOT_ACTIVE"
  | "STUDENT_WRONG_LEVEL"
  | "STUDENT_WRONG_FACULTY"
  | "STUDENT_WRONG_DEPARTMENT"
  | "OFFERING_NOT_OPEN"
  | "NO_ACTIVE_ACADEMIC_SESSION"
  | "ALREADY_ENROLLED"
  | "ALREADY_DROPPED"
  | "ALREADY_COMPLETED";

export type OfferingWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: OfferingErrorCode };

export type OfferingMutationResult =
  | { ok: true }
  | { ok: false; code: OfferingErrorCode };

interface OfferingRow {
  id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  level_id: string;
  level_name: number;
  academic_session_id: string;
  academic_session_name: string;
  semester_id: string;
  semester_name: string;
  status: OfferingStatus;
  created_at: Date;
  updated_at: Date;
}

interface AssignedLecturerRow {
  id: string;
  lecturer_id: string;
  user_id: string;
  staff_id: string;
  lecturer_name: string;
  department_id: string;
  assigned_at: Date;
}

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toOffering(row: OfferingRow): CourseOffering {
  return {
    id: Number(row.id),
    courseId: Number(row.course_id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    levelId: Number(row.level_id),
    levelName: Number(row.level_name),
    academicSessionId: Number(row.academic_session_id),
    academicSessionName: row.academic_session_name,
    semesterId: Number(row.semester_id),
    semesterName: row.semester_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssignedLecturer(row: AssignedLecturerRow): AssignedLecturer {
  return {
    id: Number(row.lecturer_id),
    userId: Number(row.user_id),
    staffId: row.staff_id,
    name: row.lecturer_name,
    departmentId: Number(row.department_id),
    assignedAt: row.assigned_at,
  };
}

const OFFERING_SELECT = `
  SELECT o.id, o.course_id, c.course_code, c.title AS course_title,
         c.level_id, l.name AS level_name,
         o.academic_session_id, sess.name AS academic_session_name,
         o.semester_id, sem.name AS semester_name,
         o.status, o.created_at, o.updated_at
  FROM course_offerings o
  JOIN courses c ON c.id = o.course_id
  JOIN levels l ON l.id = c.level_id
  JOIN academic_sessions sess ON sess.id = o.academic_session_id
  JOIN semesters sem ON sem.id = o.semester_id
  LEFT JOIN departments d ON d.id = c.department_id
`;

async function findCourseById(
  id: number
): Promise<{ id: number; status: OrganizationStatus } | null> {
  const result = await pool.query(`SELECT id, status FROM courses WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), status: row.status };
}

async function findAcademicSessionById(
  id: number
): Promise<{ id: number; name: string } | null> {
  const result = await pool.query(
    `SELECT id, name FROM academic_sessions WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: row.name };
}

async function findSemesterById(
  id: number
): Promise<{ id: number; name: string } | null> {
  const result = await pool.query(`SELECT id, name FROM semesters WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: row.name };
}

async function findOfferingById(
  id: number
): Promise<{
  id: number;
  courseId: number;
  academicSessionId: number;
  semesterId: number;
  status: OfferingStatus;
} | null> {
  const result = await pool.query(
    `SELECT id, course_id, academic_session_id, semester_id, status
     FROM course_offerings WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    courseId: Number(row.course_id),
    academicSessionId: Number(row.academic_session_id),
    semesterId: Number(row.semester_id),
    status: row.status,
  };
}

async function offeringHasRegistrations(offeringId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM course_registrations WHERE course_offering_id = $1 LIMIT 1`,
    [offeringId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function offeringHasAttendance(offeringId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM attendance_records ar
     JOIN attendance_sessions sess ON sess.id = ar.session_id
     WHERE sess.course_offering_id = $1
     LIMIT 1`,
    [offeringId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function findLecturerProfile(
  id: number
): Promise<{
  id: number;
  userId: number;
  staffId: string;
  name: string;
  userRole: Role;
  userStatus: OrganizationStatus;
} | null> {
  const result = await pool.query(
    `SELECT l.id, l.user_id, l.staff_id,
            u.name AS lecturer_name, u.role AS user_role, u.status AS user_status
     FROM lecturers l
     JOIN users u ON u.id = l.user_id
     WHERE l.id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    staffId: row.staff_id,
    name: row.lecturer_name,
    userRole: row.user_role,
    userStatus: row.user_status,
  };
}

export async function listOfferings(
  filters: OfferingListFilters
): Promise<CourseOffering[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.courseId !== undefined) {
    values.push(filters.courseId);
    conditions.push(`o.course_id = $${values.length}`);
  }
  if (filters.academicSessionId !== undefined) {
    values.push(filters.academicSessionId);
    conditions.push(`o.academic_session_id = $${values.length}`);
  }
  if (filters.semesterId !== undefined) {
    values.push(filters.semesterId);
    conditions.push(`o.semester_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`o.status = $${values.length}`);
  }
  if (filters.facultyId !== undefined) {
    values.push(filters.facultyId);
    conditions.push(`COALESCE(c.faculty_id, d.faculty_id) = $${values.length}`);
  }
  if (filters.departmentId !== undefined) {
    values.push(filters.departmentId);
    conditions.push(`c.department_id = $${values.length}`);
  }
  if (filters.levelId !== undefined) {
    values.push(filters.levelId);
    conditions.push(`c.level_id = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `${OFFERING_SELECT}
     ${whereClause}
     ORDER BY sess.name ASC, sem.name ASC, c.course_code ASC`,
    values
  );
  return result.rows.map(toOffering);
}

export async function listLecturerOpenOfferings(
  userId: number
): Promise<OfferingWriteResult<OfferingForLecturer[]>> {
  const profile = await pool.query(`SELECT id FROM lecturers WHERE user_id = $1`, [
    userId,
  ]);
  const profileRow = profile.rows[0];
  if (!profileRow) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }
  const lecturerId = Number(profileRow.id);

  const result = await pool.query(
    `SELECT o.id, c.course_code, c.title AS course_title,
            c.level_id, l.name AS level_name,
            o.academic_session_id, sess.name AS academic_session_name,
            o.semester_id, sem.name AS semester_name,
            o.status
     FROM course_offering_lecturers col
     JOIN course_offerings o ON o.id = col.course_offering_id
     JOIN courses c ON c.id = o.course_id
     JOIN levels l ON l.id = c.level_id
     JOIN academic_sessions sess ON sess.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     WHERE col.lecturer_id = $1
       AND o.status = 'OPEN'
       AND c.status = 'ACTIVE'
     ORDER BY sess.name ASC, sem.name ASC, c.course_code ASC`,
    [lecturerId]
  );

  const offerings: OfferingForLecturer[] = result.rows.map((row) => ({
    id: Number(row.id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    levelName: Number(row.level_name),
    academicSessionName: row.academic_session_name,
    semesterName: row.semester_name,
    status: row.status,
  }));

  return { ok: true, data: offerings };
}

export async function createOffering(
  input: OfferingCreateInput
): Promise<OfferingWriteResult<CourseOffering>> {
  const course = await findCourseById(input.courseId);
  if (!course) {
    return { ok: false, code: "COURSE_NOT_FOUND" };
  }
  if (course.status !== "ACTIVE") {
    return { ok: false, code: "COURSE_NOT_ACTIVE" };
  }
  const session = await findAcademicSessionById(input.academicSessionId);
  if (!session) {
    return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
  }
  const semester = await findSemesterById(input.semesterId);
  if (!semester) {
    return { ok: false, code: "SEMESTER_NOT_FOUND" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH inserted AS (
         INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
         VALUES ($1, $2, $3)
         RETURNING id, course_id, academic_session_id, semester_id, status, created_at, updated_at
       )
       ${OFFERING_SELECT.replace("FROM course_offerings o", "FROM inserted o")}`,
      [input.courseId, input.academicSessionId, input.semesterId]
    );
    await appendCourseOfferingEvent(client, "CREATED", Number(result.rows[0].id));
    await client.query("COMMIT");
    return { ok: true, data: toOffering(result.rows[0] as OfferingRow) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateOffering(
  id: number,
  input: OfferingUpdateInput
): Promise<OfferingWriteResult<CourseOffering>> {
  const existing = await findOfferingById(id);
  if (!existing) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const newCourseId = input.courseId ?? existing.courseId;
  const newAcademicSessionId = input.academicSessionId ?? existing.academicSessionId;
  const newSemesterId = input.semesterId ?? existing.semesterId;
  const identityChanged =
    newCourseId !== existing.courseId ||
    newAcademicSessionId !== existing.academicSessionId ||
    newSemesterId !== existing.semesterId;

  if (identityChanged) {
    if (await offeringHasRegistrations(id)) {
      return { ok: false, code: "HAS_REGISTRATIONS" };
    }
    if (await offeringHasAttendance(id)) {
      return { ok: false, code: "HAS_ATTENDANCE" };
    }
  }

  if (input.courseId !== undefined) {
    const course = await findCourseById(input.courseId);
    if (!course) {
      return { ok: false, code: "COURSE_NOT_FOUND" };
    }
    if (course.status !== "ACTIVE") {
      return { ok: false, code: "COURSE_NOT_ACTIVE" };
    }
  }
  if (input.academicSessionId !== undefined) {
    const session = await findAcademicSessionById(input.academicSessionId);
    if (!session) {
      return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
    }
  }
  if (input.semesterId !== undefined) {
    const semester = await findSemesterById(input.semesterId);
    if (!semester) {
      return { ok: false, code: "SEMESTER_NOT_FOUND" };
    }
  }

  const fields: Array<[string, unknown]> = [];
  if (input.courseId !== undefined) fields.push(["course_id", input.courseId]);
  if (input.academicSessionId !== undefined) {
    fields.push(["academic_session_id", input.academicSessionId]);
  }
  if (input.semesterId !== undefined) fields.push(["semester_id", input.semesterId]);
  if (input.status !== undefined) fields.push(["status", input.status]);

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH updated AS (
         UPDATE course_offerings
         SET ${sets.join(", ")}
         WHERE id = $${fields.length + 1}
         RETURNING id, course_id, academic_session_id, semester_id, status, created_at, updated_at
       )
       ${OFFERING_SELECT.replace("FROM course_offerings o", "FROM updated o")}`,
      values
    );
    const row = result.rows[0] as OfferingRow | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NOT_FOUND" };
    }
    await appendCourseOfferingEvent(client, "UPDATED", id);
    await client.query("COMMIT");
    return { ok: true, data: toOffering(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listAssignedLecturers(
  offeringId: number
): Promise<OfferingWriteResult<AssignedLecturer[]>> {
  const offering = await findOfferingById(offeringId);
  if (!offering) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const result = await pool.query(
    `SELECT col.id, col.assigned_at,
            l.id AS lecturer_id, l.user_id, l.staff_id, l.department_id,
            u.name AS lecturer_name
     FROM course_offering_lecturers col
     JOIN lecturers l ON l.id = col.lecturer_id
     JOIN users u ON u.id = l.user_id
     WHERE col.course_offering_id = $1 AND u.role = 'LECTURER'
     ORDER BY col.assigned_at ASC, col.id ASC`,
    [offeringId]
  );
  return { ok: true, data: result.rows.map(toAssignedLecturer) };
}

export async function assignLecturer(
  offeringId: number,
  input: AssignLecturerInput
): Promise<OfferingWriteResult<AssignedLecturer>> {
  const offering = await findOfferingById(offeringId);
  if (!offering) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const profile = await findLecturerProfile(input.lecturerId);
  if (!profile) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }
  if (profile.userRole !== "LECTURER") {
    return { ok: false, code: "NOT_A_LECTURER" };
  }
  if (profile.userStatus !== "ACTIVE") {
    return { ok: false, code: "LECTURER_NOT_ACTIVE" };
  }

  try {
    const result = await pool.query(
      `WITH inserted AS (
         INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
         VALUES ($1, $2)
         RETURNING id, course_offering_id, lecturer_id, assigned_at
       )
       SELECT i.id, i.assigned_at,
              l.id AS lecturer_id, l.user_id, l.staff_id, l.department_id,
              u.name AS lecturer_name
       FROM inserted i
       JOIN lecturers l ON l.id = i.lecturer_id
       JOIN users u ON u.id = l.user_id
       WHERE u.role = 'LECTURER'`,
      [offeringId, input.lecturerId]
    );
    return { ok: true, data: toAssignedLecturer(result.rows[0] as AssignedLecturerRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "ALREADY_ASSIGNED" };
    }
    throw error;
  }
}

export async function removeLecturer(
  offeringId: number,
  lecturerId: number
): Promise<OfferingMutationResult> {
  const offering = await findOfferingById(offeringId);
  if (!offering) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const result = await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id = $1 AND lecturer_id = $2`,
    [offeringId, lecturerId]
  );
  if (result.rowCount === 0) {
    return { ok: false, code: "NOT_ASSIGNED" };
  }
  return { ok: true };
}

interface RegistrationRosterRow {
  registration_id: string;
  student_id: string;
  matric_number: string;
  student_name: string;
  department_id: string;
  department_name: string;
  department_code: string;
  level_id: string;
  level_name: string;
  status: RegistrationStatus;
  registered_at: Date;
}

interface CourseOfferingContextRow {
  id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  academic_session_name: string;
  semester_name: string;
  level_id: string;
  level_name: string;
  status: OfferingStatus;
}

function toRegistrationRosterItem(row: RegistrationRosterRow): RegistrationRosterItem {
  return {
    registrationId: Number(row.registration_id),
    studentId: Number(row.student_id),
    matricNumber: row.matric_number,
    studentName: row.student_name,
    department: {
      id: Number(row.department_id),
      name: row.department_name,
      code: row.department_code,
    },
    level: {
      id: Number(row.level_id),
      name: Number(row.level_name),
    },
    status: row.status,
    registeredAt: row.registered_at,
  };
}

function toOfferingContext(row: CourseOfferingContextRow) {
  return {
    id: Number(row.id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    academicSession: row.academic_session_name,
    semester: row.semester_name,
    level: {
      id: Number(row.level_id),
      name: Number(row.level_name),
    },
    status: row.status,
  };
}

export async function getOfferingRegistrations(
  offeringId: number,
  filters: RegistrationListFilters
): Promise<OfferingWriteResult<CourseOfferingRegistrations>> {
  const offering = await findOfferingById(offeringId);
  if (!offering) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const contextResult = await pool.query(
    `SELECT o.id, o.course_id, c.course_code, c.title AS course_title,
            sess.name AS academic_session_name,
            sem.name AS semester_name,
            l.id AS level_id, l.name AS level_name,
            o.status
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions sess ON sess.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     JOIN levels l ON l.id = c.level_id
     WHERE o.id = $1`,
    [offeringId]
  );
  const contextRow = contextResult.rows[0] as CourseOfferingContextRow | undefined;
  if (!contextRow) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const conditions: string[] = ["cr.course_offering_id = $1"];
  const values: unknown[] = [offeringId];
  let paramIndex = 2;

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`cr.status = $${paramIndex++}`);
  }

  if (filters.matricNumber !== undefined) {
    values.push(`%${filters.matricNumber}%`);
    conditions.push(`st.matric_number ILIKE $${paramIndex++}`);
  }

  if (filters.studentName !== undefined) {
    values.push(`%${filters.studentName}%`);
    conditions.push(`u.name ILIKE $${paramIndex++}`);
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await pool.query(
    `SELECT count(*)::int AS total
     FROM course_registrations cr
     JOIN students st ON st.id = cr.student_id
     JOIN users u ON u.id = st.user_id
     WHERE ${whereClause}`,
    values
  );
  const total = Number(countResult.rows[0].total);

  let limitClause = "";
  if (filters.limit !== undefined && filters.limit > 0) {
    values.push(filters.limit);
    limitClause = ` LIMIT $${paramIndex++}`;
  }
  if (filters.offset !== undefined && filters.offset > 0) {
    values.push(filters.offset);
    limitClause = `${limitClause} OFFSET $${paramIndex++}`;
  }

  const itemsResult = await pool.query(
    `SELECT cr.id AS registration_id,
            st.id AS student_id,
            st.matric_number,
            u.name AS student_name,
            d.id AS department_id,
            d.name AS department_name,
            d.code AS department_code,
            l.id AS level_id,
            l.name AS level_name,
            cr.status,
            cr.registered_at
     FROM course_registrations cr
     JOIN students st ON st.id = cr.student_id
     JOIN users u ON u.id = st.user_id
     JOIN departments d ON d.id = st.department_id
     JOIN levels l ON l.id = st.level_id
     WHERE ${whereClause}
     ORDER BY u.name ASC, st.matric_number ASC
     ${limitClause}`,
    values
  );

  return {
    ok: true,
    data: {
      courseOffering: toOfferingContext(contextRow),
      total,
      items: itemsResult.rows.map(toRegistrationRosterItem),
    },
  };
}

interface AdminEnrollStudentInput {
  adminUserId: number;
  offeringId: number;
  studentId: number;
}

interface AdminEnrollmentResult {
  registration: {
    id: number;
    studentId: number;
    courseOfferingId: number;
    status: RegistrationStatus;
    createdAt: Date;
    updatedAt: Date;
  };
}

export type AdminEnrollmentWriteResult =
  | { ok: true; data: AdminEnrollmentResult }
  | { ok: false; code: OfferingErrorCode };

async function findStudentById(
  studentId: number
): Promise<{
  id: number;
  userId: number;
  matricNumber: string;
  name: string;
  departmentId: number;
  levelId: number;
  userStatus: OrganizationStatus;
} | null> {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.matric_number, s.department_id, s.level_id,
            u.name, u.status AS user_status
     FROM students s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [studentId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    matricNumber: row.matric_number,
    name: row.name,
    departmentId: Number(row.department_id),
    levelId: Number(row.level_id),
    userStatus: row.user_status,
  };
}

async function findAdminName(adminUserId: number): Promise<string | null> {
  const result = await pool.query(
    `SELECT name FROM users WHERE id = $1 AND role = 'ADMIN' LIMIT 1`,
    [adminUserId]
  );
  const row = result.rows[0];
  return row?.name ?? null;
}

export async function adminEnrollStudent(
  input: AdminEnrollStudentInput
): Promise<AdminEnrollmentWriteResult> {
  const { adminUserId, offeringId, studentId } = input;

  const offering = await findOfferingById(offeringId);
  if (!offering) {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (offering.status !== "OPEN") {
    return { ok: false, code: "OFFERING_NOT_OPEN" };
  }

  const course = await findCourseById(offering.courseId);
  if (!course) {
    return { ok: false, code: "COURSE_NOT_FOUND" };
  }
  if (course.status !== "ACTIVE") {
    return { ok: false, code: "COURSE_NOT_ACTIVE" };
  }

  const session = await findAcademicSessionById(offering.academicSessionId);
  if (!session) {
    return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
  }

  const semester = await findSemesterById(offering.semesterId);
  if (!semester) {
    return { ok: false, code: "SEMESTER_NOT_FOUND" };
  }

  const activeSession = await pool.query(
    `SELECT id FROM academic_sessions WHERE id = $1 AND is_active = true LIMIT 1`,
    [offering.academicSessionId]
  );
  if (activeSession.rowCount === 0) {
    return { ok: false, code: "NO_ACTIVE_ACADEMIC_SESSION" };
  }

  const student = await findStudentById(studentId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }
  if (student.userStatus !== "ACTIVE") {
    return { ok: false, code: "STUDENT_NOT_ACTIVE" };
  }

  const offeringDetails = await pool.query(
    `SELECT c.level_id, c.faculty_id, c.department_id
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     WHERE o.id = $1`,
    [offeringId]
  );
  const offeringDetailsRow = offeringDetails.rows[0];
  if (!offeringDetailsRow) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const offeringLevelId = Number(offeringDetailsRow.level_id);
  const courseFacultyId = offeringDetailsRow.faculty_id === null ? null : Number(offeringDetailsRow.faculty_id);
  const courseDepartmentId = offeringDetailsRow.department_id === null ? null : Number(offeringDetailsRow.department_id);

  if (student.levelId !== offeringLevelId) {
    return { ok: false, code: "STUDENT_WRONG_LEVEL" };
  }

  if (courseFacultyId !== null) {
    if (student.departmentId === undefined || student.departmentId === null) {
      return { ok: false, code: "STUDENT_WRONG_FACULTY" };
    }
    const dept = await pool.query(
      `SELECT faculty_id FROM departments WHERE id = $1`,
      [student.departmentId]
    );
    const deptRow = dept.rows[0];
    if (!deptRow || Number(deptRow.faculty_id) !== courseFacultyId) {
      return { ok: false, code: "STUDENT_WRONG_FACULTY" };
    }
  } else if (courseDepartmentId !== null) {
    if (student.departmentId !== courseDepartmentId) {
      return { ok: false, code: "STUDENT_WRONG_DEPARTMENT" };
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingReg = await client.query(
      `SELECT id, status, created_at, updated_at
       FROM course_registrations
       WHERE student_id = $1 AND course_offering_id = $2`,
      [student.id, offeringId]
    );

    if (existingReg.rowCount && existingReg.rowCount > 0) {
      const existing = existingReg.rows[0];
      await client.query("ROLLBACK");
      const existingStatus = existing.status as RegistrationStatus;
      if (existingStatus === "ENROLLED") {
        return { ok: false, code: "ALREADY_ENROLLED" };
      }
      if (existingStatus === "DROPPED") {
        return { ok: false, code: "ALREADY_DROPPED" };
      }
      if (existingStatus === "COMPLETED") {
        return { ok: false, code: "ALREADY_COMPLETED" };
      }
      return { ok: false, code: "CONFLICT" };
    }

    const regResult = await client.query(
      `INSERT INTO course_registrations (student_id, course_offering_id, status)
       VALUES ($1, $2, 'ENROLLED')
       RETURNING id, student_id, course_offering_id, status, created_at, updated_at`,
      [student.id, offeringId]
    );

    const adminName = await findAdminName(adminUserId);
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'STUDENT_COURSE_ENROLLMENT', 'course_registrations', $2, $3)`,
      [
        adminUserId,
        Number(regResult.rows[0].id),
        `Admin ${adminName ?? `(id ${adminUserId})`} enrolled student ${student.matricNumber} (${student.name}) in course offering ${offeringId}.`,
      ]
    );

    await client.query("COMMIT");

    const reg = regResult.rows[0];
    return {
      ok: true,
      data: {
        registration: {
          id: Number(reg.id),
          studentId: Number(reg.student_id),
          courseOfferingId: Number(reg.course_offering_id),
          status: reg.status as RegistrationStatus,
          createdAt: reg.created_at,
          updatedAt: reg.updated_at,
        },
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  } finally {
    client.release();
  }
}