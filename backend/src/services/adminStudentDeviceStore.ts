import { pool } from "../db/pool";
import { hashSessionToken } from "../lib/sessions";

export interface AdminStudentDeviceRow {
  id: number;
  student_id: number;
  credential_id: string;
  cred_type: string;
  aaguid: string | null;
  label: string | null;
  transports: string[] | null;
  status: string;
  enrolled_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  counter: number;
}

export interface AdminStudentDeviceSummary {
  studentId: number;
  studentName: string;
  matricNumber: string;
  device: AdminStudentDeviceRow | null;
  hasActiveDevice: boolean;
}

export async function listAdminStudentDevices(
  filters?: {
    matricNumber?: string;
    studentName?: string;
    status?: "ACTIVE" | "REVOKED" | "NO_DEVICE";
  }
): Promise<AdminStudentDeviceSummary[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  let paramIndex = 1;

  if (filters?.matricNumber) {
    conditions.push(`s.matric_number ILIKE $${paramIndex}`);
    params.push(`%${filters.matricNumber}%`);
    paramIndex++;
  }

  if (filters?.studentName) {
    conditions.push(`u.name ILIKE $${paramIndex}`);
    params.push(`%${filters.studentName}%`);
    paramIndex++;
  }

  // Filter on the student's most recent device state. `d` is the lateral alias
  // holding exactly one row per student (their latest device, or null).
  if (filters?.status === "ACTIVE") {
    conditions.push(`d.status = 'ACTIVE'`);
  } else if (filters?.status === "REVOKED") {
    conditions.push(`d.status = 'REVOKED'`);
  } else if (filters?.status === "NO_DEVICE") {
    conditions.push(`d.id IS NULL`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT
      s.id AS student_id,
      u.name AS student_name,
      s.matric_number,
      d.id AS device_id,
      d.credential_id,
      d.cred_type,
      d.aaguid,
      d.label,
      d.transports,
      d.status,
      d.enrolled_at,
      d.last_seen_at,
      d.revoked_at,
      d.counter
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM student_devices d
      WHERE d.student_id = s.id
      ORDER BY d.id DESC
      LIMIT 1
    ) d ON true
    ${whereClause}
    ORDER BY u.name, s.matric_number
  `;

  const result = await pool.query(query, params);

  return result.rows.map((row) => {
    const hasActiveDevice = row.device_id !== null && row.status === "ACTIVE";
    return {
      studentId: Number(row.student_id),
      studentName: row.student_name,
      matricNumber: row.matric_number,
      device: row.device_id
        ? {
            id: Number(row.device_id),
            student_id: Number(row.student_id),
            credential_id: row.credential_id,
            cred_type: row.cred_type,
            aaguid: row.aaguid,
            label: row.label,
            transports: row.transports,
            status: row.status,
            enrolled_at: row.enrolled_at,
            last_seen_at: row.last_seen_at,
            revoked_at: row.revoked_at,
            counter: Number(row.counter),
          }
        : null,
      hasActiveDevice,
    };
  });
}

export async function getStudentDeviceStatus(
  studentId: number
): Promise<AdminStudentDeviceSummary | null> {
  const result = await pool.query(
    `
    SELECT
      s.id AS student_id,
      u.name AS student_name,
      s.matric_number,
      d.id AS device_id,
      d.credential_id,
      d.cred_type,
      d.aaguid,
      d.label,
      d.transports,
      d.status,
      d.enrolled_at,
      d.last_seen_at,
      d.revoked_at,
      d.counter
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM student_devices d
      WHERE d.student_id = s.id
      ORDER BY d.id DESC
      LIMIT 1
    ) d ON true
    WHERE s.id = $1
    LIMIT 1
  `,
    [studentId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const hasActiveDevice = row.device_id !== null && row.status === "ACTIVE";
  return {
    studentId: Number(row.student_id),
    studentName: row.student_name,
    matricNumber: row.matric_number,
    device: row.device_id
      ? {
          id: Number(row.device_id),
          student_id: Number(row.student_id),
          credential_id: row.credential_id,
          cred_type: row.cred_type,
          aaguid: row.aaguid,
          label: row.label,
          transports: row.transports,
          status: row.status,
          enrolled_at: row.enrolled_at,
          last_seen_at: row.last_seen_at,
          revoked_at: row.revoked_at,
          counter: Number(row.counter),
        }
      : null,
    hasActiveDevice,
  };
}

export type ResetStudentDeviceResult =
  | { ok: true; device: AdminStudentDeviceRow | null; previousStatus: string }
  | { ok: false; code: "STUDENT_NOT_FOUND" | "NO_ACTIVE_DEVICE" | "CONFLICT" };

export async function resetStudentDevice(
  adminUserId: number,
  studentId: number
): Promise<ResetStudentDeviceResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const studentResult = await client.query(
      `SELECT s.id, u.name, s.matric_number
       FROM students s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND u.role = 'STUDENT'
       LIMIT 1`,
      [studentId]
    );
    if (studentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }
    const student = studentResult.rows[0];

    const deviceResult = await client.query(
      `SELECT * FROM student_devices
       WHERE student_id = $1 AND status = 'ACTIVE'
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [studentId]
    );

    if (deviceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NO_ACTIVE_DEVICE" };
    }

    const activeDevice = deviceResult.rows[0];
    const previousStatus = activeDevice.status;

    await client.query(
      `UPDATE student_devices
       SET status = 'REVOKED', revoked_at = now(), updated_at = now()
       WHERE id = $1`,
      [activeDevice.id]
    );

    await client.query(
      `UPDATE student_device_enrollment_challenges
       SET status = 'EXPIRED', consumed_at = now()
       WHERE student_id = $1 AND status = 'ACTIVE'`,
      [studentId]
    );

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'STUDENT_DEVICE_RESET', 'student_devices', $2, $3)`,
      [
        adminUserId,
        activeDevice.id,
        `Admin reset the active device for student ${student.matric_number} (${student.name}); previous status ${previousStatus}`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      device: {
        id: Number(activeDevice.id),
        student_id: Number(activeDevice.student_id),
        credential_id: activeDevice.credential_id,
        cred_type: activeDevice.cred_type,
        aaguid: activeDevice.aaguid,
        label: activeDevice.label,
        transports: activeDevice.transports,
        status: "REVOKED",
        enrolled_at: activeDevice.enrolled_at,
        last_seen_at: activeDevice.last_seen_at,
        revoked_at: new Date(),
        counter: Number(activeDevice.counter),
      },
      previousStatus,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function invalidateStudentChallenges(studentId: number): Promise<void> {
  await pool.query(
    `UPDATE student_device_enrollment_challenges
     SET status = 'EXPIRED', consumed_at = now()
     WHERE student_id = $1 AND status = 'ACTIVE'`,
    [studentId]
  );
}