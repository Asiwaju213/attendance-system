import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { webauthnConfig } from "../config/webauthn";
import { pool } from "../db/pool";
import { hashSessionToken } from "../lib/sessions";
import {
  createStudentDeviceRegistrationOptions,
  verifyStudentRegistration,
} from "../lib/webauthn";
import {
  findRevokedCredentialIds,
  findStudentByUserId,
  hasActiveDevice,
} from "./studentDeviceStore";

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
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; code: StartDeviceEnrollmentErrorCode };

export type CompleteDeviceEnrollmentResult =
  | {
      ok: true;
      credentialId: string;
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
 */
export async function startDeviceEnrollment(
  userId: number
): Promise<StartDeviceEnrollmentResult> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  if (await hasActiveDevice(student.studentId)) {
    return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
  }

  const revoked = await findRevokedCredentialIds(student.studentId);

  const options = await createStudentDeviceRegistrationOptions({
    rpName: webauthnConfig.rpName,
    rpID: webauthnConfig.rpID,
    userName: student.matricNumber,
    userDisplayName: student.name,
    userID: new TextEncoder().encode(String(student.studentId)),
    excludeCredentials: revoked.map((item) => ({
      id: item.id,
      ...(item.transports ? { transports: item.transports } : {}),
    })),
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
      return { ok: true, options };
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
 * Complete device enrollment: verify the WebAuthn registration response, consume the
 * challenge, enforce exactly-one-ACTIVE-device, and store the credential.
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

    // Race guard: never two ACTIVE devices for the same student.
    if (await hasActiveDevice(student.studentId)) {
      await client.query("ROLLBACK");
      return { ok: false, code: "DEVICE_ALREADY_ENROLLED" };
    }

    // A credential ID must never be enrolled twice, for any student, active or not.
    const used = await client.query(
      `SELECT 1 FROM student_devices WHERE credential_id = $1 LIMIT 1`,
      [verification.credential.id]
    );
    if ((used.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "CREDENTIAL_IN_USE" };
    }

    const inserted = await client.query(
      `INSERT INTO student_devices
         (student_id, credential_id, credential_public_key, counter,
          transports, cred_type, aaguid, label)
       VALUES ($1, $2, $3, $4, $5, 'public-key', $6, $7)
       RETURNING id, enrolled_at`,
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
      ]
    );
    const deviceRow = inserted.rows[0];

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'DEVICE_ENROLLED', 'student_devices', $2, $3)`,
      [
        student.userId,
        Number(deviceRow.id),
        `Student enrolled a WebAuthn device credential ${verification.credential.id}`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      credentialId: verification.credential.id,
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