import { pool } from "../db/pool";
import { appendAcademicSessionEvent } from "./syncMasterDataEmitters";
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO academic_sessions (name)
       VALUES ($1)
       RETURNING ${SESSION_COLUMNS}`,
      [input.name]
    );
    await appendAcademicSessionEvent(
      client,
      "CREATED",
      Number(result.rows[0].id)
    );
    await client.query("COMMIT");
    return { ok: true, data: toAcademicSession(result.rows[0] as AcademicSessionRow) };
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

export async function updateAcademicSession(
  id: number,
  input: AcademicSessionUpdateInput
): Promise<AcademicSessionWriteResult<AcademicSession>> {
  if (input.isActive !== undefined) {
    return updateWithActiveToggle(id, input);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE academic_sessions
       SET name = $1
       WHERE id = $2
       RETURNING ${SESSION_COLUMNS}`,
      [input.name, id]
    );
    const row = result.rows[0] as AcademicSessionRow | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACADEMIC_SESSION_NOT_FOUND" };
    }
    await appendAcademicSessionEvent(client, "UPDATED", id);
    await client.query("COMMIT");
    return { ok: true, data: toAcademicSession(row) };
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

    // Deactivating one session also deactivates whichever was active, so this
    // statement can change more rows than the one the caller named. Every row it
    // actually touches must get an event, or the edge would keep showing a
    // session the cloud has already retired.
    const toggled = await client.query(
      `UPDATE academic_sessions
       SET is_active = CASE WHEN id = $1 THEN $2 ELSE false END
       WHERE id = $1 OR is_active = true
       RETURNING id`,
      [id, input.isActive]
    );

    const affectedIds = toggled.rows.map((row) => Number(row.id));
    if (input.name !== undefined) {
      const named = affectedIds.includes(id) ? affectedIds : [id, ...affectedIds];
      for (const affectedId of new Set(named)) {
        await appendAcademicSessionEvent(client, "UPDATED", affectedId);
      }
    } else {
      for (const affectedId of affectedIds) {
        await appendAcademicSessionEvent(client, "UPDATED", affectedId);
      }
    }

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