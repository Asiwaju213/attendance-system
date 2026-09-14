import { pool } from "../db/pool";
import { Semester } from "../types/academicPeriod";
import {
  SemesterCreateInput,
  SemesterUpdateInput,
} from "../validation/adminSemesterValidation";

export type SemesterWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "SEMESTER_NOT_FOUND" | "CONFLICT" };

interface SemesterRow {
  id: string;
  name: string;
  created_at: Date;
}

const SEMESTER_COLUMNS = "id, name, created_at";

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toSemester(row: SemesterRow): Semester {
  const createdAt = row.created_at;
  return {
    id: Number(row.id),
    name: row.name,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function listSemesters(): Promise<Semester[]> {
  const result = await pool.query(
    `SELECT ${SEMESTER_COLUMNS}
     FROM semesters
     ORDER BY id ASC`
  );
  return result.rows.map(toSemester);
}

export async function createSemester(
  input: SemesterCreateInput
): Promise<SemesterWriteResult<Semester>> {
  try {
    const result = await pool.query(
      `INSERT INTO semesters (name)
       VALUES ($1)
       RETURNING ${SEMESTER_COLUMNS}`,
      [input.name]
    );
    return { ok: true, data: toSemester(result.rows[0] as SemesterRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function updateSemester(
  id: number,
  input: SemesterUpdateInput
): Promise<SemesterWriteResult<Semester>> {
  try {
    const result = await pool.query(
      `UPDATE semesters
       SET name = $1
       WHERE id = $2
       RETURNING ${SEMESTER_COLUMNS}`,
      [input.name, id]
    );
    const row = result.rows[0] as SemesterRow | undefined;
    if (!row) {
      return { ok: false, code: "SEMESTER_NOT_FOUND" };
    }
    return { ok: true, data: toSemester(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}