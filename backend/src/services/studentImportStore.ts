import { randomBytes } from "crypto";
import { pool } from "../db/pool";
import {
  buildRowsWithExistingMatrics,
  parseAndValidateWorkbook,
  PREVIEW_LIFETIME_MS,
  recalcValidCounts,
} from "../lib/excel";
import {
  ImportedStudentRow,
  StudentImportPreviewData,
  StudentImportResultData,
} from "../types/studentImport";

export type ImportErrorCode =
  | "DEPARTMENT_NOT_FOUND"
  | "DEPARTMENT_NOT_ACTIVE"
  | "LEVEL_NOT_FOUND"
  | "INVALID_FILE"
  | "EMPTY_FILE"
  | "MISSING_COLUMNS"
  | "TOO_MANY_ROWS"
  | "PREVIEW_NOT_FOUND"
  | "INVALID_BATCH"
  | "CONFLICT";

export type ImportWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ImportErrorCode };

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

interface DepartmentRow {
  id: string;
  name: string;
  status: string;
}

async function findDepartment(
  id: number
): Promise<{ id: number; name: string; status: string } | null> {
  const result = await pool.query(
    `SELECT id, name, status FROM departments WHERE id = $1`,
    [id]
  );
  const row = result.rows[0] as DepartmentRow | undefined;
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: row.name, status: row.status };
}

async function findLevelById(
  id: number
): Promise<{ id: number; name: number } | null> {
  const result = await pool.query(`SELECT id, name FROM levels WHERE id = $1`, [id]);
  const row = result.rows[0] as { id: string; name: number } | undefined;
  if (!row) {
    return null;
  }
  return { id: Number(row.id), name: Number(row.name) };
}

async function existingMatrics(matrics: string[]): Promise<Set<string>> {
  if (matrics.length === 0) {
    return new Set();
  }
  const result = await pool.query(
    `SELECT matric_number FROM students WHERE matric_number = ANY($1::TEXT[])`,
    [matrics]
  );
  return new Set(result.rows.map((row) => row.matric_number as string));
}

async function createPreview(
  departmentId: number,
  levelId: number,
  rows: ImportedStudentRow[]
): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const counts = recalcValidCounts(rows);
  await pool.query(
    `INSERT INTO student_import_previews (
       token, department_id, level_id,
       total_rows, valid_rows, invalid_rows, rows
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      token,
      departmentId,
      levelId,
      rows.length,
      counts.validRows,
      counts.invalidRows,
      JSON.stringify(rows),
    ]
  );
  return token;
}

async function loadActivePreview(
  token: string
): Promise<{ departmentId: number; levelId: number; rows: ImportedStudentRow[] } | null> {
  const result = await pool.query(
    `SELECT department_id, level_id, rows
     FROM student_import_previews
     WHERE token = $1
       AND status = 'ACTIVE'
       AND created_at > now() - ($2 * interval '1 millisecond')`,
    [token, PREVIEW_LIFETIME_MS]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    departmentId: Number(row.department_id),
    levelId: Number(row.level_id),
    rows: row.rows as ImportedStudentRow[],
  };
}

export async function previewImport(
  departmentId: number,
  levelId: number,
  buffer: Buffer
): Promise<ImportWriteResult<StudentImportPreviewData>> {
  const department = await findDepartment(departmentId);
  if (!department) {
    return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
  }
  if (department.status !== "ACTIVE") {
    return { ok: false, code: "DEPARTMENT_NOT_ACTIVE" };
  }
  const level = await findLevelById(levelId);
  if (!level) {
    return { ok: false, code: "LEVEL_NOT_FOUND" };
  }

  const parsed = await parseAndValidateWorkbook(buffer);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code };
  }

  const existing = await existingMatrics(
    parsed.rows.filter((row) => row.valid).map((row) => row.matricNumber)
  );
  buildRowsWithExistingMatrics(parsed.rows, existing);
  const counts = recalcValidCounts(parsed.rows);

  const previewToken = await createPreview(departmentId, levelId, parsed.rows);

  return {
    ok: true,
    data: {
      department: { id: department.id, name: department.name },
      level: { id: level.id, name: level.name },
      totalRows: parsed.totalRows,
      validRows: counts.validRows,
      invalidRows: counts.invalidRows,
      rows: parsed.rows,
      previewToken,
    },
  };
}

export async function confirmImport(
  token: string
): Promise<ImportWriteResult<StudentImportResultData>> {
  const preview = await loadActivePreview(token);
  if (!preview) {
    return { ok: false, code: "PREVIEW_NOT_FOUND" };
  }

  const department = await findDepartment(preview.departmentId);
  if (!department) {
    return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
  }
  if (department.status !== "ACTIVE") {
    return { ok: false, code: "DEPARTMENT_NOT_ACTIVE" };
  }
  const level = await findLevelById(preview.levelId);
  if (!level) {
    return { ok: false, code: "LEVEL_NOT_FOUND" };
  }

  if (preview.rows.some((row) => !row.valid)) {
    return { ok: false, code: "INVALID_BATCH" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const matrics = preview.rows.map((row) => row.matricNumber);
    const conflict = await client.query(
      `SELECT 1 FROM students WHERE matric_number = ANY($1::TEXT[]) LIMIT 1`,
      [matrics]
    );
    if ((conflict.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "CONFLICT" };
    }

    for (const row of preview.rows) {
      const userResult = await client.query(
        `INSERT INTO users (name, role, status, password_hash)
         VALUES ($1, 'STUDENT', 'PENDING', NULL)
         RETURNING id`,
        [row.studentName]
      );
      await client.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4)`,
        [
          Number(userResult.rows[0].id),
          row.matricNumber,
          preview.departmentId,
          preview.levelId,
        ]
      );
    }

    await client.query(
      `UPDATE student_import_previews
       SET status = 'USED', consumed_at = now()
       WHERE token = $1`,
      [token]
    );

    await client.query("COMMIT");
    return { ok: true, data: { importedCount: preview.rows.length } };
  } catch (error) {
    await client.query("ROLLBACK");
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  } finally {
    client.release();
  }
}