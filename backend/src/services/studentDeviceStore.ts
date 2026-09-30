import { PoolClient } from "pg";
import { pool } from "../db/pool";

export interface StudentDeviceContext {
  studentId: number;
  userId: number;
  matricNumber: string;
  name: string;
  /**
   * Opaque WebAuthn user handle for this student (see migration 009). Stored per student so
   * it is stable for the lifetime of the identity. Never log this value.
   */
  webauthnUserHandle: string;
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
  /**
   * TRUE only when the credential is known to be discoverable (a resident key / passkey) and
   * may therefore be used by the usernameless student login ceremony.
   *
   * NULL means "not known to be discoverable". That covers every row enrolled before migration
   * 010, which includes legacy non-discoverable credentials enrolled before
   * `residentKey: "required"`. NULL is never treated as discoverable — see
   * `isDiscoverableCredential`.
   */
  discoverable: boolean | null;
  enrolled_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

/**
 * Whether a stored credential may be relied on by the usernameless device login ceremony.
 *
 * The usernameless ceremony calls navigator.credentials.get() with no allowCredentials, so the
 * authenticator can only return a credential it can find by itself. A non-discoverable
 * credential is therefore invisible to that call. `discoverable === true` is the only value that
 * counts as a yes: NULL (unknown, i.e. every pre-migration-010 row) and FALSE both mean "no".
 *
 * Being strict here is what makes the upgrade path safe. It is not possible for a legacy
 * non-discoverable credential to be accepted by the login, and it is not possible for an
 * unknown-but-actually-discoverable credential to be wrongly refused in a way the student
 * cannot recover from, because matric-number + password login remains available and the
 * authenticated upgrade flow re-enrols the credential.
 */
export function isDiscoverableCredential(
  device: Pick<StoredDeviceRow, "discoverable">
): boolean {
  return device.discoverable === true;
}

export async function findStudentByUserId(
  userId: number
): Promise<StudentDeviceContext | null> {
  const result = await pool.query(
    `SELECT s.id AS student_id, s.user_id, s.matric_number, s.webauthn_user_handle, u.name
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
    webauthnUserHandle: row.webauthn_user_handle,
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

/**
 * Lock the student's ACTIVE device inside a transaction and return it, or null when they have
 * none.
 *
 * Used by the enrollment/upgrade ceremony, which has to read the current device and then
 * replace it in the *same* transaction. The row lock serialises two concurrent enrollment
 * attempts so only one of them can revoke-and-replace; without it both could read "legacy
 * device present" and then race on the `one_active_device_per_student` index.
 */
export async function lockActiveDeviceForEnrollment(
  client: PoolClient,
  studentId: number
): Promise<StoredDeviceRow | null> {
  const result = await client.query(
    `SELECT * FROM student_devices
     WHERE student_id = $1 AND status = 'ACTIVE'
     FOR UPDATE`,
    [studentId]
  );
  return result.rows[0] ?? null;
}

/**
 * Revoke the ACTIVE device row, but only if it is still the same row and still ACTIVE.
 *
 * Guarding on both `id` and `status` means a concurrent admin reset that already revoked this
 * device is not overwritten, and the caller can tell whether the replacement is still
 * meaningful. The row is never deleted: revoked credentials stay as an audit trail.
 */
export async function revokeDeviceRowForReplacement(
  client: PoolClient,
  deviceId: number
): Promise<boolean> {
  const result = await client.query(
    `UPDATE student_devices
        SET status = 'REVOKED', revoked_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING id`,
    [deviceId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Return the student's ACTIVE device.
 *
 * This is the lookup to use whenever the question is "which device may this student
 * authenticate with". The filter on `status = 'ACTIVE'` is explicit, so the answer can never
 * depend on which row happens to have the highest id. The `one_active_device_per_student`
 * partial unique index (migration 001) guarantees at most one such row.
 */
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
 *
 * This is deliberately NOT a substitute for `findActiveDeviceByStudentId`: "most recent row"
 * and "the row that may authenticate" only happen to coincide, and relying on that ordering
 * is exactly the ambiguity the ACTIVE-scoped query removes.
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

/**
 * Everything needed to authenticate a student from a WebAuthn credential, and nothing else.
 *
 * Identity is resolved exclusively from the credential ID that the browser returned. No
 * student id, user id, role or matric number is ever accepted as an input, so a caller cannot
 * ask "is this student signed in" by guessing identifiers.
 *
 * Revoked rows are returned rather than filtered out so the caller can distinguish "this
 * credential exists but was revoked" from "no such credential" for its own audit logging.
 * Both still produce the same generic authentication failure at the API boundary. The ORDER
 * BY prefers the ACTIVE row so the result is deterministic now that a revoked credential ID
 * may be re-enrolled as a different device row (migration 009).
 */
export interface StudentDeviceLoginCandidate {
  deviceId: number;
  credentialId: string;
  credentialPublicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[] | null;
  deviceStatus: string;
  /**
   * Whether the credential is known to be discoverable. NULL means unknown (every row enrolled
   * before migration 010). Only `true` may be used by the usernameless login ceremony.
   */
  discoverable: boolean | null;
  studentId: number;
  userId: number;
  userRole: string;
  userStatus: string;
  passwordHash: string | null;
  /** Opaque WebAuthn user handle the credential was enrolled against. Never log. */
  webauthnUserHandle: string;
  /** The student's matric number (login identifier). */
  identifier: string;
}

export async function findStudentLoginCandidateByCredentialId(
  credentialId: string
): Promise<StudentDeviceLoginCandidate | null> {
  const result = await pool.query(
    `SELECT d.id                    AS device_id,
            d.credential_id         AS credential_id,
            d.credential_public_key AS credential_public_key,
            d.counter               AS counter,
            d.transports            AS transports,
            d.status                AS device_status,
            d.discoverable          AS discoverable,
            s.id                    AS student_id,
            s.matric_number         AS identifier,
            s.webauthn_user_handle  AS webauthn_user_handle,
            u.id                    AS user_id,
            u.role                  AS user_role,
            u.status                AS user_status,
            u.password_hash         AS password_hash
     FROM student_devices d
     JOIN students s ON s.id = d.student_id
     JOIN users u ON u.id = s.user_id
     WHERE d.credential_id = $1
     ORDER BY (d.status = 'ACTIVE') DESC, d.id DESC
     LIMIT 1`,
    [credentialId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    deviceId: Number(row.device_id),
    credentialId: row.credential_id,
    credentialPublicKey: new Uint8Array(row.credential_public_key),
    counter: Number(row.counter),
    transports: row.transports ?? null,
    deviceStatus: row.device_status,
    discoverable: row.discoverable ?? null,
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
    userRole: row.user_role,
    userStatus: row.user_status,
    passwordHash: row.password_hash ?? null,
    webauthnUserHandle: row.webauthn_user_handle,
    identifier: row.identifier,
  };
}

/**
 * Re-read a device by id inside a transaction and return it only if it is still ACTIVE.
 * Used to honour a revocation that races an in-flight assertion.
 */
export async function lockActiveDeviceById(
  client: PoolClient,
  deviceId: number
): Promise<StoredDeviceRow | null> {
  const result = await client.query(
    `SELECT * FROM student_devices
     WHERE id = $1 AND status = 'ACTIVE'
     FOR UPDATE`,
    [deviceId]
  );
  return result.rows[0] ?? null;
}