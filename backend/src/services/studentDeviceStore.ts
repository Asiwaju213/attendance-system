import { pool } from "../db/pool";

export interface StudentDeviceContext {
  studentId: number;
  userId: number;
  matricNumber: string;
  name: string;
}

export interface StoredDeviceRow {
  id: number;
  student_id: number;
  credential_id: string;
  credential_public_key: Uint8Array;
  counter: number;
  transports: string[] | null;
  cred_type: string;
  aaguid: string | null;
  label: string | null;
  status: string;
  enrolled_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

export async function findStudentByUserId(
  userId: number
): Promise<StudentDeviceContext | null> {
  const result = await pool.query(
    `SELECT s.id AS student_id, s.user_id, s.matric_number, u.name
     FROM students s
     JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND u.role = 'STUDENT'
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
    matricNumber: row.matric_number,
    name: row.name,
  };
}

export async function hasActiveDevice(
  studentId: number
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [studentId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function findRevokedCredentialIds(
  studentId: number
): Promise<Array<{ id: string; transports: string[] | null }>> {
  const result = await pool.query(
    `SELECT credential_id, transports
     FROM student_devices
     WHERE student_id = $1 AND status = 'REVOKED'`,
    [studentId]
  );
  return result.rows.map((row) => ({
    id: row.credential_id,
    transports: row.transports ?? null,
  }));
}

export async function findActiveDeviceByStudentId(
  studentId: number
): Promise<StoredDeviceRow | null> {
  const result = await pool.query(
    `SELECT * FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [studentId]
  );
  return result.rows[0] ?? null;
}

/**
 * Return the most recently enrolled device for a student regardless of status.  Used to
 * distinguish "no device ever enrolled" from "device exists but is not ACTIVE".
 */
export async function findLatestDeviceByStudentId(
  studentId: number
): Promise<StoredDeviceRow | null> {
  const result = await pool.query(
    `SELECT * FROM student_devices
     WHERE student_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [studentId]
  );
  return result.rows[0] ?? null;
}

export async function updateDeviceCounter(
  deviceId: number,
  counter: number
): Promise<void> {
  await pool.query(
    `UPDATE student_devices SET counter = $2 WHERE id = $1`,
    [deviceId, counter]
  );
}

export async function findDeviceByCredentialId(
  credentialId: string
): Promise<StoredDeviceRow | null> {
  const result = await pool.query(
    `SELECT * FROM student_devices
     WHERE credential_id = $1
     LIMIT 1`,
    [credentialId]
  );
  return result.rows[0] ?? null;
}