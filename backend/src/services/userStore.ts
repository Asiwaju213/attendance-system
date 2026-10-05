import { pool } from "../db/pool";
import { AuthUser, SafeUser } from "../types/auth";

export async function findActiveUserById(id: number): Promise<AuthUser | null> {
  const result = await pool.query(
    `SELECT id, name, username, role, must_change_password
     FROM users
     WHERE id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: row.must_change_password === true,
  };
}

export async function findSafeUserById(id: number): Promise<SafeUser | null> {
  const result = await pool.query(
    `SELECT u.id, u.name, u.role, u.username, u.must_change_password,
            s.matric_number, l.staff_id
     FROM users u
     LEFT JOIN students s ON s.user_id = u.id
     LEFT JOIN lecturers l ON l.user_id = u.id
     WHERE u.id = $1 AND u.status = 'ACTIVE'
     LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    name: row.name,
    role: row.role,
    username: row.username ?? null,
    matricNumber: row.matric_number ?? null,
    staffId: row.staff_id ?? null,
    mustChangePassword: row.must_change_password === true,
  };
}
