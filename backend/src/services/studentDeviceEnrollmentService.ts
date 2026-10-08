import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { webauthnConfig } from "../config/webauthn";
import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";
import {
  createStudentDeviceRegistrationOptions,
  verifyStudentRegistration,
} from "../lib/webauthn";
import {
  findActiveDeviceByStudentId,
  findRevokedCredentialIds,
  findStudentByUserId,
  hasActiveDevice,
  isDiscoverableCredential,
  lockActiveDeviceForEnrollment,
  revokeDeviceRowForReplacement,
} from "./studentDeviceStore";
import { appendStudentDeviceEvent, appendStudentDeviceBootstrapEvent } from "./syncMasterDataEmitters";

/**
 * What kind of credential ceremony the student is starting.
 *
 * `ENROLL`  - the student has no ACTIVE device. Nothing is replaced.
 * `UPGRADE` - the student already has an ACTIVE device that is NOT known to be discoverable
 *             (a legacy credential enrolled before `residentKey: "required"`). The new
 *             discoverable credential replaces it, transactionally.
 */
export type DeviceEnrollmentMode = "ENROLL" | "UPGRADE";

/**
 * The student's current device state as reported by the read-only status endpoint.
 *
 * This is a superset of `DeviceEnrollmentMode`:
 *   ENROLL  - no ACTIVE device. Nothing to replace.
 *   UPGRADE - an ACTIVE device that is not known to be discoverable (legacy credential). It
 *             still works for attendance and can be replaced through the normal enrollment
 *             ceremony.
 *   ACTIVE  - an ACTIVE device that IS known to be discoverable, i.e. fully enrolled and ready
 *             for the usernameless login ceremony. `startDeviceEnrollment` deliberately
 *             refuses this case, so a working passkey cannot be rotated at will.
 *
 * `ACTIVE` is a status-only value: it is never a ceremony mode, because there is no ceremony
 * that starts from it.
 */
export type StudentDeviceState = "ENROLL" | "UPGRADE" | "ACTIVE";

/**
 * The device fields a student may see about their own device.
 *
 * Deliberately excludes the credential id, public key, counter, AAGUID and transports: none of
 * them are needed to render the page, and a student has no reason to be handed their own
 * credential internals.
 */
export interface StudentDeviceSummary {
  enrolledAt: Date;
  label: string | null;
}

export type StudentDeviceStatusResult =
  | {
      ok: true;
      state: StudentDeviceState;
      /**
       * The stored `discoverable` value of the ACTIVE device, or null when there is no ACTIVE
       * device. NULL is reported faithfully rather than collapsed to false, so the UI can tell a
       * pre-migration device (NULL) apart from one whose authenticator refused a resident key
       * (FALSE). Both are routed to the same upgrade action.
       */
      discoverable: boolean | null;
      device: StudentDeviceSummary | null;
    }
  | { ok: false; code: "STUDENT_NOT_FOUND" };

/**
 * Human-readable account label stored in the passkey by the authenticator.
 *
 * `user.name` is the account *hint* in WebAuthn: the authenticator and any password manager
 * that syncs the passkey may display it and store it off-device. It must therefore never carry
 * a real identifier. SimpleWebAuthn only requires a non-empty string (the WebAuthn spec
 * recommends <= 64 bytes), so there is no requirement for it to be unique — `user.id`, the
 * opaque per-student handle, is what identifies the account.
 *
 * The value is derived from the opaque handle, so it is:
 *   * stable for the lifetime of the identity (required, or the authenticator would see a new
 *     account every enrolment),
 *   * non-sensitive (a 12-character prefix of a 256-bit random value reveals nothing, and
 *     cannot be worked backwards to the handle or to any student),
 *   * distinct per student, so a student with several passkeys can still tell them apart in a
 *     credential list,
 *   * not a matric number, not a sequential student id, and not the handle itself.
 */
const CREDENTIAL_ACCOUNT_LABEL_PREFIX = "oou-student";
const CREDENTIAL_ACCOUNT_LABEL_SUFFIX_LENGTH = 12;

function buildCredentialAccountLabel(webauthnUserHandle: string): string {
  const suffix = webauthnUserHandle
    .slice(0, CREDENTIAL_ACCOUNT_LABEL_SUFFIX_LENGTH)
    .toLowerCase();
  // The handle is NOT NULL in the schema, but never let a malformed value produce an empty or
  // non-base64url label: SimpleWebAuthn and the WebAuthn spec both want a plain string here.
  if (suffix.length === 0 || !/^[0-9a-z]+$/.test(suffix)) {
    return CREDENTIAL_ACCOUNT_LABEL_PREFIX;
  }
  return `${CREDENTIAL_ACCOUNT_LABEL_PREFIX}-${suffix}`;
}

export type StartDeviceEnrollmentErrorCode =
  | "STUDENT_NOT_FOUND"
  | "DEVICE_ALREADY_ENROLLED";

export type CompleteDeviceEnrollmentErrorCode =
  | "STUDENT_NOT_FOUND"
  | "DEVICE_ALREADY_ENROLLED"
  | "INVALID_CHALLENGE"
  | "INVALID_CREDENTIAL"
  | "CREDENTIAL_IN_USE";

export type StartDeviceEnrollmentResult =
  | {
      ok: true;
      options: PublicKeyCredentialCreationOptionsJSON;
      /** Reported to the client so the UI can label the ceremony accurately. */
      mode: DeviceEnrollmentMode;
    }
  | { ok: false; code: StartDeviceEnrollmentErrorCode };

export type CompleteDeviceEnrollmentResult =
  | {
      ok: true;
      credentialId: string;
      /**
       * The device's opaque stable reference (migration 021). This - not the credential id -
       * is what the device-binding cookie carries and what the login binding lookup resolves
       * first, so the credential id never has to leave the database that enrolled it.
       */
      deviceRef: string;
      /**
       * The one-time bootstrap secret for this device (plaintext, shown exactly
       * once in this response). The student spends it on the K12 edge's
       * `/student/device/bootstrap` endpoint to bind that browser; only its
       * SHA-256 hash is stored (cloud and edge) and only the hash crosses the
       * sync boundary. Never logged, never audited, never re-issued: a second
       * secret is a second enrollment.
       */
      bootstrapSecret: string;
      /**
       * The credential this enrolment replaced, when the ceremony was an UPGRADE. The old row
       * is REVOKED, never deleted. `null` for a plain ENROLL.
       */
      replacedCredentialId: string | null;
      /**
       * Whether the new credential is known to be discoverable. A `false` here means the
       * authenticator ignored the `residentKey: "required"` request; the credential still works
       * for attendance and the student can simply run the upgrade again.
       */
      discoverable: boolean;
      device: {
        credentialId: string;
        status: "ACTIVE";
        enrolledAt: Date;
        label: string | null;
      };
    }
  | { ok: false; code: CompleteDeviceEnrollmentErrorCode };

const UNIQUE_VIOLATION_CODE = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

function deriveChallengeFromClientData(clientDataJSON: string): string | null {
  try {
    const json = Buffer.from(clientDataJSON, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { challenge?: unknown };
    if (typeof parsed.challenge !== "string" || parsed.challenge.length < 1) {
      return null;
    }
    return parsed.challenge;
  } catch {
    return null;
  }
}

/**
 * Begin device enrollment: create WebAuthn registration options for the authenticated
 * student and store the challenge server-side (hash only), bound to that student.
 *
 * Two ceremonies share this entry point, distinguished only by the student's current device:
 *
 *   ENROLL  - no ACTIVE device. Unchanged behaviour from before.
 *   UPGRADE - an ACTIVE device that is not known to be discoverable, i.e. a legacy credential
 *             enrolled before the `residentKey: "required"` policy. Such a credential works
 *             for attendance but can never be returned by the usernameless login ceremony, so
 *             instead of revoking it and stranding the student we let them enrol a discoverable
 *             replacement. The existing credential keeps working until the replacement is
 *             verified and committed; see `completeDeviceEnrollment`.
 *
 * A student whose ACTIVE device is already known to be discoverable is still refused, so this
 * cannot be used to rotate a working passkey at will.
 */
export async function startDeviceEnrollment(
  userId: number
): Promise<StartDeviceEnrollmentResult> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const activeDevice = await findActiveDeviceByStudentId(student.studentId);
  if (activeDevice !== null && isDiscoverableCredential(activeDevice)) {
    return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
  }

  // A legacy ACTIVE device means an upgrade. Its own credential must be excluded too,
  // otherwise a platform authenticator that already holds it could simply return it again and
  // the "upgrade" would silently re-enrol a non-discoverable credential.
  const revoked = await findRevokedCredentialIds(student.studentId);
  const mode: DeviceEnrollmentMode = activeDevice === null ? "ENROLL" : "UPGRADE";
  const excludedCredentialIds = [
    ...revoked.map((item) => ({
      id: item.id,
      ...(item.transports ? { transports: item.transports } : {}),
    })),
    ...(activeDevice === null
      ? []
      : [
          {
            id: activeDevice.credential_id,
            ...(activeDevice.transports
              ? { transports: activeDevice.transports }
              : {}),
          },
        ]),
  ];

  const options = await createStudentDeviceRegistrationOptions({
    rpName: webauthnConfig.rpName,
    rpID: webauthnConfig.rpID,
    // A non-sensitive, stable account label — never the matric number, never a sequential
    // student id. See `buildCredentialAccountLabel`. The credential's identity is `userID`
    // below, which is the opaque per-student WebAuthn user handle; this value is only a hint
    // for the authenticator's own storage and display.
    userName: buildCredentialAccountLabel(student.webauthnUserHandle),
    // `displayName` is the human-palatable label the student sees in their own credential
    // list, so their own registered name is the correct value here.
    userDisplayName: student.name,
    // The opaque per-student WebAuthn user handle. Previously this was
    // `String(student.studentId)`, which published a sequential, guessable database id to
    // every browser and authenticator.
    userID: new TextEncoder().encode(student.webauthnUserHandle),
    excludeCredentials: excludedCredentialIds,
  });

  const challengeHash = hashSessionToken(options.challenge);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A student may only have one live enrollment challenge at a time.
      await client.query(
        `UPDATE student_device_enrollment_challenges
         SET status = 'EXPIRED', consumed_at = now()
         WHERE student_id = $1 AND status = 'ACTIVE'`,
        [student.studentId]
      );
      await client.query(
        `INSERT INTO student_device_enrollment_challenges (student_id, challenge_hash)
         VALUES ($1, $2)`,
        [student.studentId, challengeHash]
      );
      await client.query("COMMIT");
      return { ok: true, options, mode };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error) && attempt < maxAttempts) {
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("Could not issue a device enrollment challenge.");
}

/**
 * Report the student's current device state for the authenticated student.
 *
 * This is a pure read. It deliberately does NOT reuse `startDeviceEnrollment`, because that
 * function is not a status probe: it issues a challenge and, as part of doing so, marks any
 * existing ACTIVE challenge for this student as EXPIRED (see the update above). Since the
 * challenge table holds a single ACTIVE row per student and is shared with the attendance
 * verification flow, calling the enrollment-options endpoint just to read the state would
 * cancel an in-flight enrollment *and* a pending attendance challenge. This function therefore
 * performs no ceremony at all: no challenge is created, consumed or expired, no device row is
 * written, and the attendance challenge is untouched.
 *
 * The mapping is exactly the one `startDeviceEnrollment` and the login gate use, so the status a
 * student sees always agrees with what a ceremony would do:
 *   no ACTIVE device                      -> ENROLL
 *   ACTIVE and discoverable === true      -> ACTIVE
 *   ACTIVE and discoverable === false     -> UPGRADE
 *   ACTIVE and discoverable IS NULL       -> UPGRADE
 *
 * NULL is "unknown" (every row enrolled before migration 010) and is treated as not
 * discoverable, matching `isDiscoverableCredential`. It is still reported as null so the UI can
 * describe the situation accurately instead of claiming the authenticator refused a resident key.
 */
export async function getStudentDeviceStatus(
  userId: number
): Promise<StudentDeviceStatusResult> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const activeDevice = await findActiveDeviceByStudentId(student.studentId);
  if (activeDevice === null) {
    return { ok: true, state: "ENROLL", discoverable: null, device: null };
  }

  return {
    ok: true,
    state: isDiscoverableCredential(activeDevice) ? "ACTIVE" : "UPGRADE",
    discoverable: activeDevice.discoverable ?? null,
    device: {
      enrolledAt: activeDevice.enrolled_at,
      label: activeDevice.label ?? null,
    },
  };
}

/**
 * Complete device enrollment: verify the WebAuthn registration response, consume the
 * challenge, enforce exactly-one-ACTIVE-device, and store the credential.
 *
 * When the student still holds a legacy (not-known-discoverable) ACTIVE device this becomes an
 * upgrade, and the replacement is transactional:
 *
 *   1. lock the student's ACTIVE device row
 *   2. refuse if that device is already known-discoverable, or if the "new" credential is
 *      actually that same credential (a no-op rotation would reset the signature counter and
 *      weaken clone detection for no benefit)
 *   3. refuse if the new credential ID is ACTIVE for any student
 *   4. revoke the old row, then insert the new ACTIVE row
 *
 * Step 4 happens inside one transaction, so the `one_active_device_per_student` partial unique
 * index is satisfied at every committed state and the student is never left without a usable
 * device: if anything fails, the rollback leaves the legacy credential ACTIVE and working for
 * attendance. The old row is revoked, never deleted, so the credential remains auditable.
 */
export async function completeDeviceEnrollment(
  userId: number,
  credential: RegistrationResponseJSON,
  label: string | null
): Promise<CompleteDeviceEnrollmentResult> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const challenge = deriveChallengeFromClientData(
    credential.response.clientDataJSON
  );
  if (!challenge) {
    return { ok: false, code: "INVALID_CHALLENGE" };
  }
  const challengeHash = hashSessionToken(challenge);

  const verification = await verifyStudentRegistration({
    response: credential,
    expectedChallenge: challenge,
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
  });
  if (!verification.ok) {
    return { ok: false, code: "INVALID_CREDENTIAL" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const consumed = await client.query(
      `UPDATE student_device_enrollment_challenges
       SET status = 'USED', consumed_at = now()
       WHERE student_id = $1
         AND challenge_hash = $2
         AND status = 'ACTIVE'
         AND created_at > now() - ($3 * interval '1 millisecond')
       RETURNING id`,
      [student.studentId, challengeHash, webauthnConfig.challengeTtlMs]
    );
    if ((consumed.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_CHALLENGE" };
    }

    // Lock the current ACTIVE device for the duration of the replacement. This serialises two
    // concurrent enrolment/upgrade attempts: the second blocks here, then observes the device
    // the first one created and is refused. It also upgrades the "race guard" below from a
    // check-then-act read into a lock-then-act one.
    const existingDevice = await lockActiveDeviceForEnrollment(client, student.studentId);
    const isUpgrade = existingDevice !== null;

    if (existingDevice !== null && isDiscoverableCredential(existingDevice)) {
      await client.query("ROLLBACK");
      return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
    }

    // Re-enrolling the very same credential would be a no-op that resets the stored signature
    // counter back to its registration value, so refuse it rather than pretend to upgrade.
    if (
      existingDevice !== null &&
      existingDevice.credential_id === verification.credential.id
    ) {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_CREDENTIAL" };
    }

    // A credential ID must never be ACTIVE for two students. Revoked rows are ignored: since
    // migration 009 a revoked credential ID may be re-enrolled, which is what lets a student
    // recover on the same platform authenticator after an admin device reset. The
    // `one_active_credential_id` partial unique index is the authoritative backstop below.
    const used = await client.query(
      `SELECT 1 FROM student_devices WHERE credential_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [verification.credential.id]
    );
    if ((used.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "CREDENTIAL_IN_USE" };
    }

    // Revoke before insert: the one-ACTIVE-device-per-student index forbids the other order.
    // Same transaction, so no committed state ever has two ACTIVE rows, and no failure mode
    // can leave the student with none.
    if (existingDevice !== null) {
      const revokedExisting = await revokeDeviceRowForReplacement(
        client,
        existingDevice.id
      );
      if (!revokedExisting) {
        // An admin device reset revoked it between the options call and here. Nothing left to
        // upgrade, and inserting now would race that admin action.
        await client.query("ROLLBACK");
        return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
      }
      // Publish the revocation BEFORE the replacement's creation: the edge keeps at most
      // one ACTIVE replica row per student, so it has to see this device leave ACTIVE
      // state before it sees the new one enter it. Emitted on the same client, so the
      // two events and the two row changes commit or roll back together.
      await appendStudentDeviceEvent(client, "UPDATED", existingDevice.id);
    }

    const inserted = await client.query(
      `INSERT INTO student_devices
         (student_id, credential_id, credential_public_key, counter,
          transports, cred_type, aaguid, label, discoverable)
       VALUES ($1, $2, $3, $4, $5, 'public-key', $6, $7, $8)
       RETURNING id, device_ref, enrolled_at`,
      [
        student.studentId,
        verification.credential.id,
        Buffer.from(verification.credential.publicKey),
        verification.credential.counter,
        verification.credential.transports && verification.credential.transports.length > 0
          ? verification.credential.transports
          : null,
        verification.aaguid.length > 0 ? verification.aaguid : null,
        label,
        // Recorded, never trusted for an identity decision: it only decides whether this
        // credential is later eligible for the usernameless login ceremony.
        verification.discoverable,
      ]
    );
    const deviceRow = inserted.rows[0];

    // A committed enrollment always has its event: this runs on the same client,
    // before the same COMMIT, so a rolled-back ceremony leaves no event behind.
    await appendStudentDeviceEvent(client, "CREATED", Number(deviceRow.id));

    // Mint the one-time bootstrap secret for the K12 edge, in the same
    // transaction as the device it belongs to. Two invariants live here:
    //
    //   * Only the SHA-256 hash is stored - in THIS database and in the one the
    //     event below syncs to. The plaintext exists only in the value returned
    //     to the caller of this function, which the route puts in the response
    //     body and nowhere else (not in an audit log, not in a session).
    //   * The event is appended on the same client, after the device's CREATED
    //     event, so the feed delivers device-then-secret in order and the edge
    //     can resolve the parent before the bootstrap that binds to it.
    //
    // The expiry is a database-computed timestamp plus the configured lifetime,
    // so the row's ceiling is set by the same clock that will later enforce it
    // in the consume statement - no client-supplied time is involved.
    const bootstrapSecret = generateSessionToken();
    const mintedBootstrap = await client.query(
      `INSERT INTO student_device_bootstraps
         (student_id, device_id, secret_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'))
       RETURNING sync_id`,
      [
        student.studentId,
        Number(deviceRow.id),
        hashSessionToken(bootstrapSecret),
        authConfig.deviceBootstrapLifetimeMs,
      ]
    );
    await appendStudentDeviceBootstrapEvent(
      client,
      "CREATED",
      mintedBootstrap.rows[0].sync_id as string
    );

    if (isUpgrade && existingDevice !== null) {
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
         VALUES ($1, 'DEVICE_CREDENTIAL_REPLACED', 'student_devices', $2, $3)`,
        [
          student.userId,
          Number(existingDevice.id),
          `Student replaced a non-discoverable device credential ${existingDevice.credential_id} with a discoverable one`,
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'DEVICE_ENROLLED', 'student_devices', $2, $3)`,
      [
        student.userId,
        Number(deviceRow.id),
        `Student ${isUpgrade ? "upgraded to" : "enrolled"} a WebAuthn device credential ${verification.credential.id} (discoverable: ${verification.discoverable})`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      credentialId: verification.credential.id,
      deviceRef: deviceRow.device_ref as string,
      bootstrapSecret,
      replacedCredentialId:
        isUpgrade && existingDevice !== null ? existingDevice.credential_id : null,
      discoverable: verification.discoverable,
      device: {
        credentialId: verification.credential.id,
        status: "ACTIVE" as const,
        enrolledAt: deviceRow.enrolled_at,
        label,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    // Backstop for concurrent writes; should never be reached thanks to the checks
    // above, but the DB constraints guarantee correctness if it is.
    if (isUniqueViolation(error)) {
      if (await hasActiveDevice(student.studentId)) {
        return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
      }
      return { ok: false, code: "CREDENTIAL_IN_USE" };
    }
    throw error;
  } finally {
    client.release();
  }
}