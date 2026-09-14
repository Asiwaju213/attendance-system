import { pool } from "../db/pool";
import { CourseScope } from "../types/course";
import {
  EligibleCoursesPayload,
  RegisteredCourseRef,
  RegistrationResultPayload,
  StudentOfferingCourse,
} from "../types/studentCourseRegistration";

export type StudentCourseErrorCode =
  | "STUDENT_NOT_FOUND"
  | "NO_ACTIVE_ACADEMIC_SESSION"
  | "INVALID_COURSE_SELECTION";

export type EligibleCoursesResult =
  | { ok: true; data: EligibleCoursesPayload }
  | { ok: false; code: "STUDENT_NOT_FOUND" };

export type RegisterCoursesResult =
  | { ok: true; data: RegistrationResultPayload }
  | { ok: false; code: StudentCourseErrorCode };

interface StudentContext {
  studentId: number;
  departmentId: number;
  facultyId: number;
  levelId: number;
}

interface OfferingRow {
  offering_id: string;
  offering_status: string;
  academic_session_id: string;
  semester_id: string;
  course_id: string;
  course_code: string;
  title: string;
  level_id: string;
  course_status: string;
  faculty_id: string | null;
  department_id: string | null;
}

async function findStudentContext(userId: number): Promise<StudentContext | null> {
  const result = await pool.query(
    `SELECT s.id AS student_id, s.department_id, s.level_id, d.faculty_id
     FROM students s
     JOIN departments d ON d.id = s.department_id
     WHERE s.user_id = $1
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    studentId: Number(row.student_id),
    departmentId: Number(row.department_id),
    facultyId: Number(row.faculty_id),
    levelId: Number(row.level_id),
  };
}

async function findActiveAcademicSession(): Promise<{ id: number; name: string } | null> {
  const result = await pool.query(
    `SELECT id, name FROM academic_sessions
     WHERE is_active = true
     ORDER BY id ASC
     LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: row.name };
}

const ELIGIBLE_OFFERING_SELECT = `
  SELECT o.id AS offering_id, o.academic_session_id, o.semester_id,
         c.id AS course_id, c.course_code, c.title, c.faculty_id, c.department_id,
         l.name AS level_name,
         d.id AS dept_id, d.name AS dept_name, d.code AS dept_code,
         f.id AS fac_id, f.name AS fac_name, f.code AS fac_code,
         sem.name AS semester_name
  FROM course_offerings o
  JOIN courses c ON c.id = o.course_id
  JOIN levels l ON l.id = c.level_id
  JOIN semesters sem ON sem.id = o.semester_id
  LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN faculties f ON f.id = c.faculty_id
`;

export async function getEligibleCourses(
  userId: number
): Promise<EligibleCoursesResult> {
  const student = await findStudentContext(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const session = await findActiveAcademicSession();
  if (!session) {
    return { ok: true, data: { academicSession: null, courses: [] } };
  }

  const result = await pool.query(
    `${ELIGIBLE_OFFERING_SELECT}
     WHERE o.academic_session_id = $1
       AND o.status = 'OPEN'
       AND c.status = 'ACTIVE'
       AND c.level_id = $2
       AND (
         (c.faculty_id IS NOT NULL AND c.faculty_id = $3)
         OR
         (c.department_id IS NOT NULL AND c.department_id = $4)
       )
     ORDER BY c.course_code ASC, o.id ASC`,
    [session.id, student.levelId, student.facultyId, student.departmentId]
  );

  const offeredRows = result.rows;
  if (offeredRows.length === 0) {
    return {
      ok: true,
      data: {
        academicSession: { id: session.id, name: session.name },
        courses: [],
      },
    };
  }

  const offeringIds = offeredRows.map((row) => Number(row.offering_id));

  const registrationRows = await pool.query(
    `SELECT course_offering_id
     FROM course_registrations
     WHERE student_id = $1
       AND status = 'ENROLLED'
       AND course_offering_id = ANY($2::BIGINT[])`,
    [student.studentId, offeringIds]
  );
  const registeredSet = new Set(
    registrationRows.rows.map((row) => Number(row.course_offering_id))
  );

  const lecturerRows = await pool.query(
    `SELECT col.course_offering_id, l.id AS lecturer_id, u.name AS lecturer_name
     FROM course_offering_lecturers col
     JOIN lecturers l ON l.id = col.lecturer_id
     JOIN users u ON u.id = l.user_id
     WHERE col.course_offering_id = ANY($1::BIGINT[]) AND u.role = 'LECTURER'
     ORDER BY l.id ASC, col.course_offering_id ASC`,
    [offeringIds]
  );
  const lecturersByOffering = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of lecturerRows.rows) {
    const offeringId = Number(row.course_offering_id);
    const list = lecturersByOffering.get(offeringId) ?? [];
    list.push({ id: Number(row.lecturer_id), name: row.lecturer_name });
    lecturersByOffering.set(offeringId, list);
  }

  const courses: StudentOfferingCourse[] = offeredRows.map((row) => {
    const offeringId = Number(row.offering_id);
    const scope: CourseScope = row.faculty_id !== null ? "FACULTY" : "DEPARTMENT";
    return {
      offeringId,
      courseId: Number(row.course_id),
      courseCode: row.course_code,
      title: row.title,
      level: Number(row.level_name),
      scope,
      department:
        row.department_id !== null && row.dept_id !== null
          ? { id: Number(row.dept_id), name: row.dept_name, code: row.dept_code }
          : null,
      faculty:
        row.faculty_id !== null && row.fac_id !== null
          ? { id: Number(row.fac_id), name: row.fac_name, code: row.fac_code }
          : null,
      semester: { id: Number(row.semester_id), name: row.semester_name },
      lecturers: lecturersByOffering.get(offeringId) ?? [],
      isRegistered: registeredSet.has(offeringId),
    };
  });

  return {
    ok: true,
    data: {
      academicSession: { id: session.id, name: session.name },
      courses,
    },
  };
}

function toCourseRef(item: OfferingRow): RegisteredCourseRef {
  return {
    offeringId: Number(item.offering_id),
    courseCode: item.course_code,
    title: item.title,
  };
}

export async function registerCourses(
  userId: number,
  offeringIds: number[]
): Promise<RegisterCoursesResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const studentResult = await client.query(
      `SELECT s.id AS student_id, s.department_id, s.level_id, d.faculty_id
       FROM students s
       JOIN departments d ON d.id = s.department_id
       WHERE s.user_id = $1
       LIMIT 1`,
      [userId]
    );
    const studentRow = studentResult.rows[0];
    if (!studentRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }
    const student: StudentContext = {
      studentId: Number(studentRow.student_id),
      departmentId: Number(studentRow.department_id),
      facultyId: Number(studentRow.faculty_id),
      levelId: Number(studentRow.level_id),
    };

    const sessionResult = await client.query(
      `SELECT id FROM academic_sessions
       WHERE is_active = true
       ORDER BY id ASC
       LIMIT 1`
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NO_ACTIVE_ACADEMIC_SESSION" };
    }
    const activeSessionId = Number(sessionRow.id);

    const offeringResult = await client.query(
      `SELECT o.id AS offering_id, o.status AS offering_status,
              o.academic_session_id, o.semester_id,
              c.id AS course_id, c.course_code, c.title,
              c.level_id, c.status AS course_status,
              c.faculty_id, c.department_id
       FROM course_offerings o
       JOIN courses c ON c.id = o.course_id
       WHERE o.id = ANY($1::BIGINT[])`,
      [offeringIds]
    );
    const offeringById = new Map<number, OfferingRow>();
    for (const row of offeringResult.rows) {
      offeringById.set(Number(row.offering_id), row as OfferingRow);
    }

    const validOfferingIds: number[] = [];
    for (const offeringId of offeringIds) {
      const row = offeringById.get(offeringId);
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, code: "INVALID_COURSE_SELECTION" };
      }
      const facultyScoped = row.faculty_id !== null;
      const scopeOk = facultyScoped
        ? Number(row.faculty_id) === student.facultyId
        : Number(row.department_id) === student.departmentId;
      const valid =
        row.offering_status === "OPEN" &&
        Number(row.academic_session_id) === activeSessionId &&
        row.course_status === "ACTIVE" &&
        Number(row.level_id) === student.levelId &&
        scopeOk;
      if (!valid) {
        await client.query("ROLLBACK");
        return { ok: false, code: "INVALID_COURSE_SELECTION" };
      }
      validOfferingIds.push(offeringId);
    }

    const registered: RegisteredCourseRef[] = [];
    const alreadyRegistered: RegisteredCourseRef[] = [];
    for (const offeringId of validOfferingIds) {
      const inserted = await client.query(
        `INSERT INTO course_registrations (student_id, course_offering_id)
         VALUES ($1, $2)
         ON CONFLICT (student_id, course_offering_id) DO NOTHING
         RETURNING id`,
        [student.studentId, offeringId]
      );
      const item = toCourseRef(offeringById.get(offeringId)!);
      if ((inserted.rowCount ?? 0) > 0) {
        registered.push(item);
      } else {
        alreadyRegistered.push(item);
      }
    }

    await client.query("COMMIT");
    return { ok: true, data: { registered, alreadyRegistered } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}