import { pool } from "../db/pool";
import { AcademicSession } from "../types/academicPeriod";
import {
  AcademicSessionCreateInput,
  AcademicSessionUpdateInput,
} from "../validation/adminAcademicSessionValidation";

export type AcademicSessionWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "ACADEMIC_SESSION_NOT_FOUND" | "CONFLICT" };

interface AcademicSessionRow {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
}

const SESSION_COLUMNS = "id, name, is_active, created_at";

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toAcademicSession(row: AcademicSessionRow): AcademicSession {
  const createdAt = row.created_at;
  return {
    id: Number(row.id),
    name: row.name,
    isActive: row.is_active,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function listAcademicSessions(): Promise<AcademicSession[]> {
  const result = await pool.query(
    `SELECT ${SESSION_COLUMNS}
     FROM academic_sessions
     ORDER BY created_at ASC, id ASC`
  );
  return result.rows.map(toAcademicSession);
}

export async function createAcademicSession(
  input: AcademicSessionCreateInput
): Promise<AcademicSessionWriteResult<AcademicSession>> {
  try {
    const result = await pool.query(
      `INSERT INTO academic_sessions (name)
       VALUES ($1)
       RETURNING ${SESSION_COLUMNS}`,
      [input.name]
    );
    return { ok: true, data: toAcademicSession(result.rows[0] as AcademicSessionRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function updateAcademicSession(
  id: number,
  input: AcademicSessionUpdateInput
): Promise<AcademicSessionWriteResult<AcademicSession>> {
  if (input.isActive !== undefined) {
    return updateWithActiveToggle(id, input);
  }

  try {
    const result = await pool.query(
      `UPDATE academic_sessions
       SET name = $1
       WHERE id = $2
       RETURNING ${SESSION_COLUMNS}`,
      [input.name, id]
    );
    const row = result.rows[0] as AcademicSessionRow | undefined;
    if (!row) {
      return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
    }
    return { ok: true, data: toAcademicSession(row) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

async function updateWithActiveToggle(
  id: number,
  input: AcademicSessionUpdateInput
): Promise<AcademicSessionWriteResult<AcademicSession>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE academic_sessions IN SHARE ROW EXCLUSIVE MODE");

    const exists = await client.query(
      `SELECT id FROM academic_sessions WHERE id = $1`,
      [id]
    );
    if (exists.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
    }

    if (input.name !== undefined) {
      await client.query(
        `UPDATE academic_sessions SET name = $1 WHERE id = $2`,
        [input.name, id]
      );
    }

    await client.query(
      `UPDATE academic_sessions
       SET is_active = CASE WHEN id = $1 THEN $2 ELSE false END
       WHERE id = $1 OR is_active = true`,
      [id, input.isActive]
    );

    const result = await client.query(
      `SELECT ${SESSION_COLUMNS} FROM academic_sessions WHERE id = $1`,
      [id]
    );
    await client.query("COMMIT");
    return { ok: true, data: toAcademicSession(result.rows[0] as AcademicSessionRow) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  } finally {
    client.release();
  }
}