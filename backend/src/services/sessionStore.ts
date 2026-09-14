import { pool } from "../db/pool";

export interface SessionRow {
  id: number;
  user_id: number;
  session_token_hash: string;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

export async function createSession(
  userId: number,
  sessionTokenHash: string,
  expiresAt: Date
): Promise<SessionRow> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, sessionTokenHash, expiresAt]
  );
  return result.rows[0];
}

export async function findSessionByTokenHash(
  sessionTokenHash: string
): Promise<SessionRow | null> {
  const result = await pool.query(
    `SELECT * FROM sessions WHERE session_token_hash = $1 LIMIT 1`,
    [sessionTokenHash]
  );
  return result.rows[0] ?? null;
}

export function isSessionActive(session: SessionRow, now: Date = new Date()): boolean {
  return session.revoked_at === null && session.expires_at > now;
}

export async function revokeSession(sessionId: number): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId]
  );
}

export async function updateLastSeen(sessionId: number): Promise<void> {
  await pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [
    sessionId,
  ]);
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE expires_at <= now() AND revoked_at IS NULL`
  );
  return result.rowCount ?? 0;
}