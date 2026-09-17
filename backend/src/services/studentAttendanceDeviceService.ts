import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { webauthnConfig } from "../config/webauthn";
import { pool } from "../db/pool";
import { hashSessionToken } from "../lib/sessions";
import {
  createStudentDeviceRequestOptions,
  verifyStudentDevice,
} from "../lib/webauthn";
import type { MarkedAttendance } from "../types/attendanceSession";
import { markAttendance, MarkAttendanceErrorCode } from "./studentAttendanceStore";
import {
  findLatestDeviceByStudentId,
  findStudentByUserId,
} from "./studentDeviceStore";

export type AttendanceChallengeErrorCode =
  | "STUDENT_NOT_FOUND"
  | "NO_ENROLLED_DEVICE"
  | "DEVICE_NOT_ACTIVE";

export type AttendanceChallengeResult =
  | { ok: true; data: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; code: AttendanceChallengeErrorCode };

export type AttendanceDeviceProofErrorCode =
  | "STUDENT_NOT_FOUND"
  | "NO_ENROLLED_DEVICE"
  | "DEVICE_NOT_ACTIVE"
  | "INVALID_CHALLENGE"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_ALREADY_USED"
  | "INVALID_DEVICE_ASSERTION";

export type MarkAttendanceWithDeviceResult =
  | { ok: true; data: MarkedAttendance }
  | { ok: false; code: AttendanceDeviceProofErrorCode | MarkAttendanceErrorCode };

const UNIQUE_VIOLATION_CODE = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

/**
 * Device verification for attendance uses the same `student_device_enrollment_challenges`
 * table as enrollment.  The table binds a challenge to a student (via `student_id`) but has
 * no explicit device column.
 *
 * Current system supports one ACTIVE device per student. Device binding is therefore
 * enforced by matching the assertion credential ID against the student's sole ACTIVE
 * device. If multi-device support is introduced later, explicit challenge-to-device
 * binding should be added.
 */

/**
 * Begin the attendance device-verification flow: verify the student has an ACTIVE enrolled
 * device, build a short-lived assertion challenge, and store only its hash (bound to the
 * student), reusing the device-challenge table.
 */
export async function createAttendanceDeviceChallenge(
  userId: number
): Promise<AttendanceChallengeResult> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const latestDevice = await findLatestDeviceByStudentId(student.studentId);
  if (!latestDevice) {
    return { ok: false, code: "NO_ENROLLED_DEVICE" };
  }
  if (latestDevice.status !== "ACTIVE") {
    return { ok: false, code: "DEVICE_NOT_ACTIVE" };
  }

  const options = await createStudentDeviceRequestOptions({
    rpID: webauthnConfig.rpID,
    credential: {
      id: latestDevice.credential_id,
      transports: latestDevice.transports ?? null,
    },
  });

  const challengeHash = hashSessionToken(options.challenge);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A student may only have one live device challenge at a time, across both the
      // enrollment and attendance flows.  Expire any existing one before inserting.
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
      return { ok: true, data: options };
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
  throw new Error("Could not issue an attendance device challenge.");
}

interface ChallengeRow {
  id: string;
  status: string;
  created_at: Date;
}

/**
 * Verify a WebAuthn assertion against the enrolled device, consuming the challenge only on
 * success.  Runs in its own transaction so replay/concurrency is safe: a `FOR UPDATE` lock
 * on the challenge row serializes concurrent consumers, and the challenge is marked USED
 * only after the signature, origin, RP ID, challenge match, student and device state have
 * all been confirmed.
 */
async function verifyAttendanceDeviceProof(
  userId: number,
  challenge: string,
  assertion: AuthenticationResponseJSON
): Promise<{ ok: true } | { ok: false; code: AttendanceDeviceProofErrorCode }> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  const latestDevice = await findLatestDeviceByStudentId(student.studentId);
  if (!latestDevice) {
    return { ok: false, code: "NO_ENROLLED_DEVICE" };
  }
  if (latestDevice.status !== "ACTIVE") {
    return { ok: false, code: "DEVICE_NOT_ACTIVE" };
  }

  const challengeHash = hashSessionToken(challenge);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const challengeResult = await client.query(
      `SELECT id, status, created_at
       FROM student_device_enrollment_challenges
       WHERE student_id = $1 AND challenge_hash = $2
       FOR UPDATE`,
      [student.studentId, challengeHash]
    );
    const challengeRow = challengeResult.rows[0] as ChallengeRow | undefined;
    if (!challengeRow) {
      // Unreachable for hashes issued to this student; also covers challenges belonging to
      // other students without revealing why.
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_CHALLENGE" };
    }
    if (challengeRow.status === "USED") {
      await client.query("ROLLBACK");
      return { ok: false, code: "CHALLENGE_ALREADY_USED" };
    }
    if (challengeRow.status === "EXPIRED") {
      await client.query("ROLLBACK");
      return { ok: false, code: "CHALLENGE_EXPIRED" };
    }
    if (
      challengeRow.created_at.getTime() <=
      Date.now() - webauthnConfig.attendanceChallengeTtlMs
    ) {
      await client.query("ROLLBACK");
      return { ok: false, code: "CHALLENGE_EXPIRED" };
    }

    // Re-read the device under a lock so a revocation racing this transaction is respected,
    // and bind the assertion to the student's sole ACTIVE device.
    const deviceResult = await client.query(
      `SELECT id, credential_id, credential_public_key, counter, transports, status
       FROM student_devices
       WHERE student_id = $1
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [student.studentId]
    );
    const deviceRow = deviceResult.rows[0];
    if (!deviceRow || deviceRow.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "DEVICE_NOT_ACTIVE" };
    }
    if (deviceRow.credential_id !== assertion.id) {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_DEVICE_ASSERTION" };
    }

    const verification = await verifyStudentDevice({
      credential: {
        id: deviceRow.credential_id,
        publicKey: new Uint8Array(deviceRow.credential_public_key),
        counter: Number(deviceRow.counter),
        transports: deviceRow.transports ?? undefined,
      },
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: webauthnConfig.expectedOrigin,
      expectedRPID: webauthnConfig.rpID,
    });
    if (!verification.ok) {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_DEVICE_ASSERTION" };
    }

    const consumed = await client.query(
      `UPDATE student_device_enrollment_challenges
       SET status = 'USED', consumed_at = now()
       WHERE student_id = $1 AND challenge_hash = $2 AND status = 'ACTIVE'
       RETURNING id`,
      [student.studentId, challengeHash]
    );
    if ((consumed.rowCount ?? 0) === 0) {
      // Lost a race with a concurrent consumer that committed between our SELECT and here.
      await client.query("ROLLBACK");
      return { ok: false, code: "CHALLENGE_ALREADY_USED" };
    }

    // Persist the new signature counter to detect cloned authenticators and stop replays.
    await client.query(
      `UPDATE student_devices SET counter = $2 WHERE id = $1`,
      [Number(deviceRow.id), verification.newCounter]
    );

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The authoritative attendance write: verify the device proof first, and only then delegate
 * to the existing `markAttendance`, whose transaction stays fully intact (session/offering/
 * course/enrollment checks, server-side PRESENT/LATE and timestamp, duplicate + concurrency
 * protection).
 */
export async function markAttendanceWithDeviceProof(
  userId: number,
  attendanceSessionId: number,
  challenge: string,
  assertion: AuthenticationResponseJSON
): Promise<MarkAttendanceWithDeviceResult> {
  const proof = await verifyAttendanceDeviceProof(userId, challenge, assertion);
  if (!proof.ok) {
    return { ok: false, code: proof.code };
  }

  return markAttendance(userId, attendanceSessionId);
}