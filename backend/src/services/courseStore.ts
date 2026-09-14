import { pool } from "../db/pool";
import { Course, CourseScope } from "../types/course";
import { OrganizationStatus } from "../types/organization";
import {
  CourseCreateInput,
  CourseListFilters,
  CourseUpdateInput,
} from "../validation/adminCourseValidation";
import { findFacultyById } from "./organizationStore";

export type CourseWriteResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "CONFLICT"
        | "FACULTY_NOT_FOUND"
        | "DEPARTMENT_NOT_FOUND"
        | "LEVEL_NOT_FOUND";
    };

interface CourseRow {
  id: string;
  course_code: string;
  title: string;
  level_id: string;
  level_name: number;
  course_faculty_id: string | null;
  course_faculty_name: string | null;
  department_id: string | null;
  department_name: string | null;
  dept_faculty_id: string | null;
  dept_faculty_name: string | null;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toCourse(row: CourseRow): Course {
  const courseFacultyId =
    row.course_faculty_id === null ? null : Number(row.course_faculty_id);
  const scope: CourseScope = courseFacultyId !== null ? "FACULTY" : "DEPARTMENT";

  return {
    id: Number(row.id),
    courseCode: row.course_code,
    title: row.title,
    levelId: Number(row.level_id),
    levelName: Number(row.level_name),
    scope,
    facultyId:
      scope === "FACULTY"
        ? courseFacultyId
        : row.dept_faculty_id === null
          ? null
          : Number(row.dept_faculty_id),
    facultyName: scope === "FACULTY" ? row.course_faculty_name : row.dept_faculty_name,
    departmentId: scope === "FACULTY" ? null : row.department_id === null ? null : Number(row.department_id),
    departmentName: scope === "FACULTY" ? null : row.department_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COURSE_SELECT = `
  SELECT c.id, c.course_code, c.title, c.level_id, c.status, c.created_at, c.updated_at,
         l.name AS level_name,
         c.faculty_id AS course_faculty_id,
         c.department_id, d.name AS department_name,
         f.name AS course_faculty_name,
         d.faculty_id AS dept_faculty_id, f2.name AS dept_faculty_name
  FROM courses c
  JOIN levels l ON l.id = c.level_id
  LEFT JOIN faculties f ON f.id = c.faculty_id
  LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN faculties f2 ON f2.id = d.faculty_id
`;

async function findLevelById(id: number): Promise<{ id: number; name: number } | null> {
  const result = await pool.query(`SELECT id, name FROM levels WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: Number(row.name) };
}

async function findDepartmentById(
  id: number
): Promise<{ id: number; name: string; facultyId: number } | null> {
  const result = await pool.query(
    `SELECT id, name, faculty_id FROM departments WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: row.name, facultyId: Number(row.faculty_id) };
}

export async function listCourses(filters: CourseListFilters): Promise<Course[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.facultyId !== undefined) {
    values.push(filters.facultyId);
    conditions.push(`COALESCE(c.faculty_id, d.faculty_id) = $${values.length}`);
  }
  if (filters.departmentId !== undefined) {
    values.push(filters.departmentId);
    conditions.push(`c.department_id = $${values.length}`);
  }
  if (filters.levelId !== undefined) {
    const level = await findLevelById(filters.levelId);
    if (!level) {
      return [];
    }
    values.push(level.id);
    conditions.push(`c.level_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`c.status = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `${COURSE_SELECT}
     ${whereClause}
     ORDER BY l.name ASC, c.course_code ASC`,
    values
  );
  return result.rows.map(toCourse);
}

export async function createCourse(
  input: CourseCreateInput
): Promise<CourseWriteResult<Course>> {
  const level = await findLevelById(input.levelId);
  if (!level) {
    return { ok: false, code: "LEVEL_NOT_FOUND" };
  }

  if (input.facultyId !== undefined) {
    const faculty = await findFacultyById(input.facultyId);
    if (!faculty) {
      return { ok: false, code: "FACULTY_NOT_FOUND" };
    }
  } else {
    const department = await findDepartmentById(input.departmentId!);
    if (!department) {
      return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
    }
  }

  try {
    const result = await pool.query(
      `WITH inserted AS (
         INSERT INTO courses (course_code, title, level_id, faculty_id, department_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, course_code, title, level_id, status, faculty_id, department_id, created_at, updated_at
       )
       ${COURSE_SELECT.replace(
         "FROM courses c",
         "FROM inserted c"
       )}`,
      [
        input.courseCode,
        input.title,
        level.id,
        input.facultyId ?? null,
        input.departmentId ?? null,
      ]
    );
    return { ok: true, data: toCourse(result.rows[0] as CourseRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function updateCourse(
  id: number,
  input: CourseUpdateInput
): Promise<CourseWriteResult<Course>> {
  if (input.levelId !== undefined) {
    const level = await findLevelById(input.levelId);
    if (!level) {
      return { ok: false, code: "LEVEL_NOT_FOUND" };
    }
  }
  if (input.facultyId !== undefined) {
    const faculty = await findFacultyById(input.facultyId);
    if (!faculty) {
      return { ok: false, code: "FACULTY_NOT_FOUND" };
    }
  } else if (input.departmentId !== undefined) {
    const department = await findDepartmentById(input.departmentId);
    if (!department) {
      return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
    }
  }

  const fields: Array<[string, unknown]> = [];
  if (input.courseCode !== undefined) fields.push(["course_code", input.courseCode]);
  if (input.title !== undefined) fields.push(["title", input.title]);
  if (input.levelId !== undefined) {
    const level = await findLevelById(input.levelId);
    fields.push(["level_id", level!.id]);
  }
  if (input.status !== undefined) fields.push(["status", input.status]);
  if (input.facultyId !== undefined) {
    fields.push(["faculty_id", input.facultyId]);
    fields.push(["department_id", null]);
  } else if (input.departmentId !== undefined) {
    fields.push(["department_id", input.departmentId]);
    fields.push(["faculty_id", null]);
  }

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  try {
    const result = await pool.query(
      `WITH updated AS (
         UPDATE courses
         SET ${sets.join(", ")}
         WHERE id = $${fields.length + 1}
         RETURNING id, course_code, title, level_id, status, faculty_id, department_id, created_at, updated_at
       )
       ${COURSE_SELECT.replace("FROM courses c", "FROM updated c")}`,
      values
    );
    const row = result.rows[0] as CourseRow | undefined;
    if (!row) {
      return { ok: false, code: "NOT_FOUND" };
    }
    return { ok: true, data: toCourse(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}