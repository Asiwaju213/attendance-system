import { pool } from "../db/pool";
import {
  AssignedLecturer,
  CourseOffering,
  OfferingForLecturer,
  OfferingStatus,
} from "../types/courseOffering";
import { OrganizationStatus } from "../types/organization";
import { Role } from "../types/auth";
import {
  AssignLecturerInput,
  OfferingCreateInput,
  OfferingListFilters,
  OfferingUpdateInput,
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
  | "NOT_ASSIGNED";

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

  try {
    const result = await pool.query(
      `WITH inserted AS (
         INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
         VALUES ($1, $2, $3)
         RETURNING id, course_id, academic_session_id, semester_id, status, created_at, updated_at
       )
       ${OFFERING_SELECT.replace("FROM course_offerings o", "FROM inserted o")}`,
      [input.courseId, input.academicSessionId, input.semesterId]
    );
    return { ok: true, data: toOffering(result.rows[0] as OfferingRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
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

  try {
    const result = await pool.query(
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
      return { ok: false, code: "NOT_FOUND" };
    }
    return { ok: true, data: toOffering(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
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