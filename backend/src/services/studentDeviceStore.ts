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
 * Everything a device-binding login needs, and nothing credential-shaped.
 *
 * The lookup this type is returned by answers one question: "does this browser
 * hold a binding for an ACTIVE device of a student who may sign in". It is the
 * password-login proof, not a WebAuthn ceremony, so unlike
 * `StudentDeviceLoginCandidate` it carries no public key, no counter, no
 * transports and no credential id - those stay behind
 * `findStudentLoginCandidateByCredentialId`, which the usernameless ceremony
 * uses.
 *
 * `source` says where the binding was resolved from, and it decides one gate:
 *
 *   * `"device"` - a local `student_devices` row. `discoverable` is the stored
 *     flag, and the login gate requires it to be `true` exactly as before, so
 *     this path's behaviour is unchanged from the credential-id-only lookup.
 *   * `"replica"` - the edge's `sync_student_devices` projection, which holds a
 *     cloud device's opaque reference and status and deliberately holds no
 *     credential. There is no discoverable flag to check, and none is needed:
 *     the discoverable gate exists because the usernameless ceremony can only
 *     find a discoverable credential, and this path never runs a ceremony. The
 *     binding cookie plus the password is the proof, both verified against
 *     local data.
 *
 * `deviceRef` is the value the binding lookup resolves on the next request: the
 * local device's `device_ref` for a local row (a legacy credential-id cookie is
 * re-issued as this value on refresh, migrating the browser without a ceremony)
 * or the cloud's `cloud_device_ref` for a replica row.
 */
export interface StudentDeviceBindingCandidate {
  source: "device" | "replica";
  deviceRef: string;
  deviceStatus: string;
  discoverable: boolean | null;
  studentId: number;
  userId: number;
  userRole: string;
  userStatus: string;
  identifier: string;
}

/**
 * Resolve a device-binding cookie value to a login candidate.
 *
 * Three sources, in priority order, because the cookie has held three different
 * things over the system's life and all three must keep working:
 *
 *   1. `student_devices.device_ref` - what enrollment writes now (migration
 *      021). A UUID, and the only value that is safe to travel: it identifies
 *      the device without identifying the credential.
 *   2. `student_devices.credential_id` - what enrollment wrote before this
 *      task, and what browsers still holding a pre-upgrade cookie present.
 *      Kept so the upgrade does not sign anyone out; the login route re-issues
 *      the cookie as `deviceRef`, so a browser is migrated on its first
 *      successful login. Credential-id ordering matches
 *      `findStudentLoginCandidateByCredentialId`: uniqueness is ACTIVE-only
 *      (migration 009), so a revoked id may exist alongside a re-enrolled one
 *      and the ACTIVE row wins.
 *   3. `sync_student_devices.cloud_device_ref` - a cloud-enrolled device seen
 *      through the sync feed. This is the cross-database case: the edge holds
 *      the device's state but never its credential, so the binding resolves
 *      against the projection while the password is still checked against the
 *      local `users` row by the login route.
 *
 * Every branch joins the local `students` and `users` rows, so a binding can
 * never resolve to a student that does not exist here, and role/status gating
 * reads the same local columns it always did.
 *
 * A cookie value that is not a UUID-shaped string can only be a credential id
 * (or garbage), so the two UUID-column branches are skipped for it: comparing
 * arbitrary text against a UUID column raises a database error rather than
 * matching nothing, and a legacy cookie must resolve - or miss - not crash.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findStudentLoginCandidateByBinding(
  binding: string
): Promise<StudentDeviceBindingCandidate | null> {
  // A binding cookie from before migration 021 is a credential id - arbitrary
  // text - and PostgreSQL rejects a non-UUID string compared against a UUID
  // column, which would turn a legacy cookie into a 500 instead of a lookup
  // miss. The two UUID branches run only for a UUID-shaped value; the
  // credential-id branch below is text and always runs.
  const looksLikeUuid = UUID_SHAPE.test(binding);

  if (looksLikeUuid) {
    const localDeviceRef = await pool.query(
      `SELECT 'device'  AS source,
              d.device_ref AS device_ref,
              d.status     AS device_status,
              d.discoverable AS discoverable,
              s.id         AS student_id,
              s.matric_number AS identifier,
              u.id         AS user_id,
              u.role       AS user_role,
              u.status     AS user_status
         FROM student_devices d
         JOIN students s ON s.id = d.student_id
         JOIN users u ON u.id = s.user_id
        WHERE d.device_ref = $1
        LIMIT 1`,
      [binding]
    );
    const refRow = localDeviceRef.rows[0];
    if (refRow) return toBindingCandidate(refRow);
  }

  const localCredential = await pool.query(
    `SELECT 'device' AS source,
            d.device_ref AS device_ref,
            d.status     AS device_status,
            d.discoverable AS discoverable,
            s.id         AS student_id,
            s.matric_number AS identifier,
            u.id         AS user_id,
            u.role       AS user_role,
            u.status     AS user_status
       FROM student_devices d
       JOIN students s ON s.id = d.student_id
       JOIN users u ON u.id = s.user_id
      WHERE d.credential_id = $1
      ORDER BY (d.status = 'ACTIVE') DESC, d.id DESC
      LIMIT 1`,
    [binding]
  );
  const credentialRow = localCredential.rows[0];
  if (credentialRow) return toBindingCandidate(credentialRow);

  if (looksLikeUuid) {
    const replica = await pool.query(
      `SELECT 'replica' AS source,
              sd.cloud_device_ref AS device_ref,
              sd.status   AS device_status,
              NULL        AS discoverable,
              s.id        AS student_id,
              s.matric_number AS identifier,
              u.id        AS user_id,
              u.role      AS user_role,
              u.status    AS user_status
         FROM sync_student_devices sd
         JOIN students s ON s.id = sd.student_id
         JOIN users u ON u.id = s.user_id
        WHERE sd.cloud_device_ref = $1
        LIMIT 1`,
      [binding]
    );
    const replicaRow = replica.rows[0];
    if (replicaRow) return toBindingCandidate(replicaRow);
  }

  return null;
}

function toBindingCandidate(row: Record<string, unknown>): StudentDeviceBindingCandidate {
  return {
    source: row.source as "device" | "replica",
    deviceRef: row.device_ref as string,
    deviceStatus: row.device_status as string,
    discoverable: row.discoverable === null || row.discoverable === undefined
      ? null
      : Boolean(row.discoverable),
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
    userRole: row.user_role as string,
    userStatus: row.user_status as string,
    identifier: row.identifier as string,
  };
}

/**
 * Spend a one-time device bootstrap secret and return the device reference it
 * unlocked, or null when it could not be spent.
 *
 * This is the only statement that ever changes a bootstrap row, and it is a
 * single UPDATE so the spend is atomic: two concurrent requests presenting the
 * same secret race on the row lock and exactly one of them matches
 * `status = 'PENDING'`, so the secret is spent once and no second caller can
 * observe a spendable row.
 *
 * Every condition is re-checked inside that statement, none of them trusted
 * from the request:
 *
 *   * `secret_hash` matches - the caller proved knowledge of the plaintext.
 *   * `status = 'PENDING'` - not already spent.
 *   * `expires_at > now()` - the database's clock, the same clock that stamped
 *     the expiry at mint time, decides validity.
 *   * the row's student is THIS caller's student - a secret for one student
 *     can never be spent by another, even if its hash were known.
 *   * that student's device in the projection is ACTIVE - a secret minted
 *     before a revocation cannot bind a revoked device, and revocation takes
 *     effect for bootstrap the moment it syncs.
 *
 * The route has already verified the student's password and account status
 * against local data; this function adds nothing user-supplied beyond the hash
 * and the user id. On success the returned value is the opaque device
 * reference the caller's binding cookie should carry - never the hash, never
 * anything credential-shaped.
 */
export async function consumeStudentDeviceBootstrap(
  secretHash: string,
  userId: number
): Promise<string | null> {
  const result = await pool.query(
    `UPDATE sync_student_device_bootstraps b
        SET status = 'CONSUMED', consumed_at = now(), updated_at = now()
      WHERE b.secret_hash = $1
        AND b.status = 'PENDING'
        AND b.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM students s
           WHERE s.user_id = $2 AND s.id = b.student_id
        )
        AND EXISTS (
          SELECT 1 FROM sync_student_devices d
           WHERE d.cloud_device_ref = b.cloud_device_ref
             AND d.student_id = b.student_id
             AND d.status = 'ACTIVE'
        )
      RETURNING b.cloud_device_ref`,
    [secretHash, userId]
  );
  const row = result.rows[0];
  return row ? (row.cloud_device_ref as string) : null;
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