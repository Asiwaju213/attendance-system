import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import {
  AdminStudentDetail,
  AdminStudentDevice,
  AdminStudentListData,
  AdminStudentListItem,
  AdminStudentRegistrationResetData,
  AdminStudentStatus,
} from "../types/studentAdmin";
import { AdminStudentListFilterInput } from "../validation/adminStudentValidation";

export type UpdateStudentStatusResult =
  | { ok: true; data: AdminStudentListItem }
  | {
      ok: false;
      code: "STUDENT_NOT_FOUND" | "NO_OP_CORRECTION" | "ACTIVE_REQUIRES_PASSWORD";
    };

export type ResetStudentRegistrationResult =
  | { ok: true; data: AdminStudentRegistrationResetData }
  | {
      ok: false;
      code: "STUDENT_NOT_FOUND" | "ALREADY_PENDING" | "INVALID_STUDENT_STATE";
    };

type StudentRow = Record<string, unknown>;

const STUDENT_FROM = `
  FROM students s
  JOIN users u ON u.id = s.user_id
  JOIN departments d ON d.id = s.department_id
  JOIN levels l ON l.id = s.level_id
`;

const STUDENT_LIST_COLUMNS = `
  SELECT
    s.id AS student_id,
    u.id AS user_id,
    u.name,
    s.matric_number,
    d.id AS department_id,
    d.name AS department_name,
    d.code AS department_code,
    l.id AS level_id,
    l.name AS level_name,
    u.status,
    u.created_at,
    cr.registered_count,
    dv.has_active_device
`;

// One aggregate, bounded query per pagination page: profile, department, level,
// enrolled-course count, and active-device existence come from the same read so
// there are no N+1 lookups. Only ENROLLED registrations are counted and the
// active-device indicator reflects an ACTIVE student_devices row.
function buildStudentFilterClause(
  filters: AdminStudentListFilterInput
): { where: string; params: unknown[] } {
  const conditions: string[] = ["u.role = 'STUDENT'"];
  const params: unknown[] = [];
  let index = 1;

  if (filters.matricNumber) {
    conditions.push(`s.matric_number ILIKE $${index++}`);
    params.push(`%${filters.matricNumber}%`);
  }
  if (filters.name) {
    conditions.push(`u.name ILIKE $${index++}`);
    params.push(`%${filters.name}%`);
  }
  if (filters.departmentId !== undefined) {
    conditions.push(`s.department_id = $${index++}`);
    params.push(filters.departmentId);
  }
  if (filters.levelId !== undefined) {
    conditions.push(`s.level_id = $${index++}`);
    params.push(filters.levelId);
  }
  if (filters.status !== undefined) {
    conditions.push(`u.status = $${index++}`);
    params.push(filters.status);
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

function toListItem(row: StudentRow): AdminStudentListItem {
  return {
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
    name: row.name as string,
    matricNumber: row.matric_number as string,
    department: {
      id: Number(row.department_id),
      name: row.department_name as string,
      code: row.department_code as string,
    },
    level: { id: Number(row.level_id), name: Number(row.level_name) },
    status: row.status as AdminStudentStatus,
    registeredCourseCount: Number(row.registered_count),
    hasActiveDevice: row.has_active_device === true,
    createdAt: row.created_at as Date,
  };
}

function toDeviceSummary(row: StudentRow): AdminStudentDevice | null {
  if (row.device_id === null || row.device_id === undefined) {
    return null;
  }
  return {
    id: Number(row.device_id),
    credentialId: row.credential_id as string,
    credType: row.cred_type as string,
    aaguid: (row.aaguid as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    transports: (row.transports as string[] | null) ?? null,
    status: row.device_status as string,
    enrolledAt: row.enrolled_at as Date,
    lastSeenAt: (row.last_seen_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    counter: Number(row.counter),
  };
}

export async function listAdminStudents(
  filters: AdminStudentListFilterInput
): Promise<AdminStudentListData> {
  const { where, params } = buildStudentFilterClause(filters);

  const countResult = await pool.query(
    `SELECT count(*)::int AS total
     FROM students s
     JOIN users u ON u.id = s.user_id
     ${where}`,
    params
  );

  const itemsResult = await pool.query(
    `${STUDENT_LIST_COLUMNS}
     ${STUDENT_FROM}
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS registered_count
       FROM course_registrations
       WHERE student_id = s.id AND status = 'ENROLLED'
     ) cr ON true
     LEFT JOIN LATERAL (
       SELECT EXISTS(
         SELECT 1 FROM student_devices
         WHERE student_id = s.id AND status = 'ACTIVE'
       ) AS has_active_device
     ) dv ON true
     ${where}
     ORDER BY u.name ASC, s.matric_number ASC`,
    params
  );

  return {
    total: Number(countResult.rows[0].total),
    items: itemsResult.rows.map(toListItem),
  };
}

export async function getAdminStudentDetail(
  studentId: number
): Promise<AdminStudentDetail | null> {
  const result = await pool.query(
    `${STUDENT_LIST_COLUMNS},
            f.id AS faculty_id,
            f.name AS faculty_name,
            f.code AS faculty_code,
            dev.id AS device_id,
            dev.credential_id,
            dev.cred_type,
            dev.aaguid,
            dev.label,
            dev.transports,
            dev.status AS device_status,
            dev.enrolled_at,
            dev.last_seen_at,
            dev.revoked_at,
            dev.counter
     ${STUDENT_FROM}
     JOIN faculties f ON f.id = d.faculty_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS registered_count
       FROM course_registrations
       WHERE student_id = s.id AND status = 'ENROLLED'
     ) cr ON true
     LEFT JOIN LATERAL (
       SELECT EXISTS(
         SELECT 1 FROM student_devices
         WHERE student_id = s.id AND status = 'ACTIVE'
       ) AS has_active_device
     ) dv ON true
     LEFT JOIN LATERAL (
       SELECT *
       FROM student_devices
       WHERE student_id = s.id
       ORDER BY id DESC
       LIMIT 1
     ) dev ON true
     WHERE s.id = $1 AND u.role = 'STUDENT'
     LIMIT 1`,
    [studentId]
  );

  const row = result.rows[0] as StudentRow | undefined;
  if (!row) {
    return null;
  }

  return {
    ...toListItem(row),
    faculty: {
      id: Number(row.faculty_id),
      name: row.faculty_name as string,
      code: row.faculty_code as string,
    },
    device: toDeviceSummary(row),
  };
}

async function findAdminName(adminUserId: number): Promise<string | null> {
  const result = await pool.query(
    `SELECT name FROM users WHERE id = $1 AND role = 'ADMIN' LIMIT 1`,
    [adminUserId]
  );
  const row = result.rows[0] as { name?: string } | undefined;
  return row?.name ?? null;
}

export async function updateStudentStatus(
  adminUserId: number,
  studentId: number,
  newStatus: "ACTIVE" | "INACTIVE"
): Promise<UpdateStudentStatusResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const adminName = await findAdminName(adminUserId);

    // Lock the target user row so concurrent status changes (or registration
    // resets) serialize on the same row and never race on stale status values.
    const studentResult = await client.query(
      `SELECT u.id AS user_id,
              u.name,
              u.password_hash,
              u.status,
              u.created_at,
              s.id AS student_id,
              s.matric_number,
              d.id AS department_id,
              d.name AS department_name,
              d.code AS department_code,
              l.id AS level_id,
              l.name AS level_name,
              cr.registered_count,
              dv.has_active_device
       FROM students s
       JOIN users u ON u.id = s.user_id
       JOIN departments d ON d.id = s.department_id
       JOIN levels l ON l.id = s.level_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS registered_count
         FROM course_registrations
         WHERE student_id = s.id AND status = 'ENROLLED'
       ) cr ON true
       LEFT JOIN LATERAL (
         SELECT EXISTS(
           SELECT 1 FROM student_devices
           WHERE student_id = s.id AND status = 'ACTIVE'
         ) AS has_active_device
       ) dv ON true
       WHERE s.id = $1 AND u.role = 'STUDENT'
       FOR UPDATE OF u
       LIMIT 1`,
      [studentId]
    );
    const row = studentResult.rows[0] as StudentRow | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }

    const previousStatus = row.status as AdminStudentStatus;
    if (previousStatus === newStatus) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NO_OP_CORRECTION" };
    }

    // Activation requires a usable credential; an account with no password
    // (PENDING/unclaimed, or any inconsistent INACTIVE-with-NULL state) must
    // never become ACTIVE, or login would be permanently impossible.
    if (newStatus === "ACTIVE" && row.password_hash === null) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACTIVE_REQUIRES_PASSWORD" };
    }

    await client.query(`UPDATE users SET status = $1 WHERE id = $2`, [
      newStatus,
      row.user_id,
    ]);

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'STUDENT_STATUS_CHANGE', 'users', $2, $3)`,
      [
        adminUserId,
        row.user_id,
        `Admin ${adminName ?? `(id ${adminUserId})`} changed status for student ${row.matric_number} (${row.name}) from ${previousStatus} to ${newStatus}.`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      data: { ...toListItem(row), status: newStatus },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resetStudentRegistration(
  adminUserId: number,
  studentId: number
): Promise<ResetStudentRegistrationResult> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const adminName = await findAdminName(adminUserId);

    // Lock the target user row: the status transition (ACTIVE -> PENDING) and
    // the challenge expirations all happen in this one serialized transaction,
    // so two simultaneous resets can never both succeed.
    const studentResult = await client.query(
      `SELECT u.id AS user_id,
              u.name,
              u.password_hash,
              u.status,
              s.id AS student_id,
              s.matric_number
       FROM students s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND u.role = 'STUDENT'
       FOR UPDATE OF u
       LIMIT 1`,
      [studentId]
    );
    const row = studentResult.rows[0] as StudentRow | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }

    const previousStatus = row.status as AdminStudentStatus;
    if (previousStatus === "PENDING") {
      await client.query("ROLLBACK");
      return { ok: false, code: "ALREADY_PENDING" };
    }
    if (previousStatus !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_STUDENT_STATE" };
    }

    // Return the account to the unclaimed state so the student can re-claim it
    // through the existing self-registration flow (set a new password). Not a
    // password-setting operation: the hash is cleared, never replaced.
    await client.query(
      `UPDATE users SET status = 'PENDING', password_hash = NULL WHERE id = $1`,
      [row.user_id]
    );

    // Expire any competing registration challenges so a stale challenge cannot
    // later be consumed by anyone.
    await client.query(
      `UPDATE student_registration_challenges
       SET status = 'EXPIRED', consumed_at = now()
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [row.user_id]
    );

    // Expire any outstanding device-enrollment challenges. The existing active
    // WebAuthn device is intentionally NOT revoked in this slice (policy
    // decision deferred); it is left untouched.
    await client.query(
      `UPDATE student_device_enrollment_challenges
       SET status = 'EXPIRED', consumed_at = now()
       WHERE student_id = $1 AND status = 'ACTIVE'`,
      [row.student_id]
    );

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'STUDENT_REGISTRATION_RESET', 'users', $2, $3)`,
      [
        adminUserId,
        row.user_id,
        `Admin ${adminName ?? `(id ${adminUserId})`} reset registration for student ${row.matric_number} (${row.name}); previous status ${previousStatus}.`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      data: {
        ok: true,
        studentId: Number(row.student_id),
        userId: Number(row.user_id),
        name: row.name as string,
        matricNumber: row.matric_number as string,
        previousStatus,
        status: "PENDING",
      },
    };
  } catch (error) {
    if (client !== null) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    if (client !== null) {
      client.release();
    }
  }
}