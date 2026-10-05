import { pool } from "../db/pool";
import { appendLecturerEvent } from "./syncMasterDataEmitters";
import { AdminLecturer } from "../types/adminLecturer";
import { OrganizationStatus } from "../types/organization";
import { CreateLecturerInput } from "../validation/adminLecturerValidation";

interface LecturerRow {
  id: string;
  user_id: string;
  staff_id: string;
  name: string;
  department_id: string;
  department_name: string;
  department_code: string;
  status: OrganizationStatus;
  must_change_password: boolean;
}

export type CreateLecturerResult =
  | { ok: true; data: AdminLecturer }
  | { ok: false; code: "DEPARTMENT_NOT_FOUND" | "CONFLICT" };

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toAdminLecturer(row: LecturerRow): AdminLecturer {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    staffId: row.staff_id,
    name: row.name,
    departmentId: Number(row.department_id),
    departmentName: row.department_name,
    departmentCode: row.department_code,
    status: row.status,
    mustChangePassword: row.must_change_password === true,
  };
}

export async function listActiveLecturers(): Promise<AdminLecturer[]> {
  const result = await pool.query(
    `SELECT l.id, l.user_id, l.staff_id, l.department_id,
            u.name, u.status, u.must_change_password,
            d.name AS department_name, d.code AS department_code
     FROM lecturers l
     JOIN users u ON u.id = l.user_id
     JOIN departments d ON d.id = l.department_id
     WHERE u.role = 'LECTURER' AND u.status = 'ACTIVE'
     ORDER BY u.name ASC, l.staff_id ASC`
  );
  return result.rows.map((row: LecturerRow) => toAdminLecturer(row));
}

/**
 * Create a lecturer account together with its lecturer profile.
 *
 * `passwordHash` is the already-hashed temporary credential, produced by the route from the
 * Argon2id helper: this store never sees the plaintext. The account is created ACTIVE so the
 * lecturer can sign in immediately, with `must_change_password` set so the only thing that
 * session may do is replace that credential.
 *
 * One transaction covers the user row, the lecturer row, the master-data change event and the
 * audit entry, so a lecturer can never exist without its audit trail. A duplicate staff id is
 * rejected by the `lecturers_staff_id_key` unique constraint rather than by a racy
 * check-then-insert.
 */
export async function createLecturerAccount(
  adminUserId: number,
  input: CreateLecturerInput,
  passwordHash: string
): Promise<CreateLecturerResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const department = await client.query(
      `SELECT id FROM departments WHERE id = $1 LIMIT 1`,
      [input.departmentId]
    );
    if (!department.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
    }

    const admin = await client.query(
      `SELECT name FROM users WHERE id = $1 AND role = 'ADMIN' LIMIT 1`,
      [adminUserId]
    );
    const adminName = (admin.rows[0] as { name?: string } | undefined)?.name ?? null;

    const userResult = await client.query(
      `INSERT INTO users (name, password_hash, role, status, must_change_password)
       VALUES ($1, $2, 'LECTURER', 'ACTIVE', true)
       RETURNING id`,
      [input.name, passwordHash]
    );
    const userId = Number(userResult.rows[0].id);

    const lecturerResult = await client.query(
      `WITH inserted AS (
         INSERT INTO lecturers (user_id, staff_id, department_id)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, staff_id, department_id
       )
SELECT i.id, i.user_id, i.staff_id, i.department_id,
               u.name, u.status, u.must_change_password,
               d.name AS department_name, d.code AS department_code
       FROM inserted i
       JOIN users u ON u.id = i.user_id
       JOIN departments d ON d.id = i.department_id`,
      [userId, input.staffId, input.departmentId]
    );
    const row = lecturerResult.rows[0] as LecturerRow;

    await appendLecturerEvent(client, "CREATED", Number(row.id));

    // Names the account and the temporary credential's obligation, never the credential itself.
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'LECTURER_ACCOUNT_CREATED', 'users', $2, $3)`,
      [
        adminUserId,
        userId,
        `Admin ${adminName ?? `(id ${adminUserId})`} created lecturer ${input.staffId} (${input.name}); a temporary password was issued and must be changed at first sign-in.`,
      ]
    );

    await client.query("COMMIT");

    return { ok: true, data: toAdminLecturer(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = pgErrorCode(error);
    if (code === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    if (code === "23503") {
      return { ok: false, code: "DEPARTMENT_NOT_FOUND" };
    }
    throw error;
  } finally {
    client.release();
  }
}
