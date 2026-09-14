import { pool } from "../db/pool";
import {
  DepartmentWithFaculty,
  Faculty,
  OrganizationStatus,
} from "../types/organization";
import {
  DepartmentCreateInput,
  DepartmentUpdateInput,
  FacultyCreateInput,
  FacultyUpdateInput,
} from "../validation/adminOrgValidation";

export type OrganizationWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "FACULTY_NOT_FOUND" };

interface FacultyRow {
  id: string;
  name: string;
  code: string;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  status: OrganizationStatus;
  faculty_id: string;
  faculty_name: string;
  faculty_code: string;
  created_at: Date;
  updated_at: Date;
}

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toFaculty(row: FacultyRow): Faculty {
  return {
    id: Number(row.id),
    name: row.name,
    code: row.code,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDepartmentWithFaculty(row: DepartmentRow): DepartmentWithFaculty {
  return {
    id: Number(row.id),
    name: row.name,
    code: row.code,
    status: row.status,
    facultyId: Number(row.faculty_id),
    facultyName: row.faculty_name,
    facultyCode: row.faculty_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listFaculties(): Promise<Faculty[]> {
  const result = await pool.query(
    `SELECT id, name, code, status, created_at, updated_at
     FROM faculties
     ORDER BY name ASC, id ASC`
  );
  return result.rows.map(toFaculty);
}

export async function findFacultyById(id: number): Promise<Faculty | null> {
  const result = await pool.query(
    `SELECT id, name, code, status, created_at, updated_at
     FROM faculties
     WHERE id = $1`,
    [id]
  );
  const row = result.rows[0] as FacultyRow | undefined;
  return row ? toFaculty(row) : null;
}

export async function createFaculty(
  input: FacultyCreateInput
): Promise<OrganizationWriteResult<Faculty>> {
  try {
    const result = await pool.query(
      `INSERT INTO faculties (name, code)
       VALUES ($1, $2)
       RETURNING id, name, code, status, created_at, updated_at`,
      [input.name, input.code]
    );
    return { ok: true, data: toFaculty(result.rows[0] as FacultyRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function updateFaculty(
  id: number,
  input: FacultyUpdateInput
): Promise<OrganizationWriteResult<Faculty>> {
  const fields: Array<[string, unknown]> = [];
  if (input.name !== undefined) fields.push(["name", input.name]);
  if (input.code !== undefined) fields.push(["code", input.code]);
  if (input.status !== undefined) fields.push(["status", input.status]);

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE faculties
       SET ${sets.join(", ")}
       WHERE id = $${fields.length + 1}
       RETURNING id, name, code, status, created_at, updated_at`,
      values
    );
    const row = result.rows[0] as FacultyRow | undefined;
    if (!row) {
      return { ok: false, code: "NOT_FOUND" };
    }
    return { ok: true, data: toFaculty(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function listDepartments(): Promise<DepartmentWithFaculty[]> {
  const result = await pool.query(
    `SELECT d.id, d.name, d.code, d.status, d.created_at, d.updated_at,
            f.id AS faculty_id, f.name AS faculty_name, f.code AS faculty_code
     FROM departments d
     JOIN faculties f ON f.id = d.faculty_id
     ORDER BY f.name ASC, d.name ASC, d.id ASC`
  );
  return result.rows.map(toDepartmentWithFaculty);
}

export async function createDepartment(
  input: DepartmentCreateInput
): Promise<OrganizationWriteResult<DepartmentWithFaculty>> {
  try {
    const result = await pool.query(
      `WITH inserted AS (
         INSERT INTO departments (name, code, faculty_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, code, status, faculty_id, created_at, updated_at
       )
       SELECT i.id, i.name, i.code, i.status, i.created_at, i.updated_at,
              f.id AS faculty_id, f.name AS faculty_name, f.code AS faculty_code
       FROM inserted i
       JOIN faculties f ON f.id = i.faculty_id`,
      [input.name, input.code, input.facultyId]
    );
    return { ok: true, data: toDepartmentWithFaculty(result.rows[0] as DepartmentRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    if (pgErrorCode(error) === "23503") {
      return { ok: false, code: "FACULTY_NOT_FOUND" };
    }
    throw error;
  }
}

export async function updateDepartment(
  id: number,
  input: DepartmentUpdateInput
): Promise<OrganizationWriteResult<DepartmentWithFaculty>> {
  const fields: Array<[string, unknown]> = [];
  if (input.name !== undefined) fields.push(["name", input.name]);
  if (input.code !== undefined) fields.push(["code", input.code]);
  if (input.facultyId !== undefined) fields.push(["faculty_id", input.facultyId]);
  if (input.status !== undefined) fields.push(["status", input.status]);

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  try {
    const result = await pool.query(
      `WITH updated AS (
         UPDATE departments
         SET ${sets.join(", ")}
         WHERE id = $${fields.length + 1}
         RETURNING id, name, code, status, faculty_id, created_at, updated_at
       )
       SELECT u.id, u.name, u.code, u.status, u.created_at, u.updated_at,
              f.id AS faculty_id, f.name AS faculty_name, f.code AS faculty_code
       FROM updated u
       JOIN faculties f ON f.id = u.faculty_id`,
      values
    );
    const row = result.rows[0] as DepartmentRow | undefined;
    if (!row) {
      return { ok: false, code: "NOT_FOUND" };
    }
    return { ok: true, data: toDepartmentWithFaculty(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    if (pgErrorCode(error) === "23503") {
      return { ok: false, code: "FACULTY_NOT_FOUND" };
    }
    throw error;
  }
}