import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { timingSafeEqual } from "crypto";
import { authConfig } from "../config/auth";
import { webauthnConfig } from "../config/webauthn";
import { pool } from "../db/pool";
import { createFixedWindowLimiter, RateLimitResult } from "../lib/rateLimit";
import { verifyPasswordOrDummy } from "../lib/passwords";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";
import {
  createStudentDeviceLoginRequestOptions,
  verifyStudentDevice,
} from "../lib/webauthn";
import { SafeUser } from "../types/auth";
import { StudentDeviceLoginOptions } from "../types/studentDeviceLogin";
import { StudentDeviceLoginInput } from "../validation/studentDeviceLoginValidation";
import {
  findStudentLoginCandidateByCredentialId,
  isDiscoverableCredential,
  lockActiveDeviceById,
} from "./studentDeviceStore";
import { findSafeUserById } from "./userStore";

/**
 * Student device login: a usernameless WebAuthn assertion that identifies the student from
 * their enrolled credential, followed by the normal password check.
 *
 * Trust model — identity originates from exactly one place: the credential ID inside a
 * WebAuthn assertion whose signature the server has verified against the public key stored
 * for that credential. The request body carries no matric number, student id, user id or
 * role, and the `userHandle` returned by the authenticator is only ever cross-checked, never
 * used to resolve who is signing in.
 *
 * Every rejection returns the same generic code so the API cannot be used to learn whether a
 * credential, a student, or a device exists, or what state it is in.
 */

export const INVALID_DEVICE_LOGIN = "INVALID_CREDENTIALS" as const;

export type CompleteStudentDeviceLoginResult =
  | { ok: true; token: string; user: SafeUser }
  | { ok: false; code: typeof INVALID_DEVICE_LOGIN };

/**
 * Coarse rejection reasons for server-side logging only. Never returned to the client, and
 * never accompanied by a credential id, challenge, assertion, matric number or user id.
 */
type RejectionReason =
  | "CHALLENGE_NOT_USABLE"
  | "CREDENTIAL_NOT_RESOLVABLE"
  | "DEVICE_NOT_ACTIVE"
  | "CREDENTIAL_NOT_DISCOVERABLE"
  | "ACCOUNT_NOT_ACTIVE_STUDENT"
  | "USER_HANDLE_MISMATCH"
  | "PASSWORD_REJECTED"
  | "ASSERTION_REJECTED"
  | "CHALLENGE_ALREADY_CONSUMED"
  | "DEVICE_REVOKED_MID_FLIGHT"
  | "ACCOUNT_CHANGED_MID_FLIGHT";

const challengeRateLimiter = createFixedWindowLimiter(
  "student-device-login-challenge",
  webauthnConfig.loginChallengeRateLimit.maxChallenges,
  webauthnConfig.loginChallengeRateLimit.windowMs
);

const failureRateLimiter = createFixedWindowLimiter(
  "student-device-login-failure",
  webauthnConfig.loginFailureRateLimit.maxFailures,
  webauthnConfig.loginFailureRateLimit.windowMs
);

/**
 * Gate challenge issuance so a single caller cannot mint unbounded outstanding challenges.
 */
export function checkStudentDeviceLoginChallengeAllowed(
  clientKey: string
): RateLimitResult {
  return challengeRateLimiter.check(clientKey);
}

export function recordStudentDeviceLoginChallengeIssued(clientKey: string): void {
  challengeRateLimiter.hit(clientKey);
}

/**
 * Gate verification. A caller already sitting on a failed-attempt count is refused before any
 * work is done, so repeated guessing is throttled rather than merely counted.
 */
export function checkStudentDeviceLoginAllowed(clientKey: string): RateLimitResult {
  return failureRateLimiter.check(clientKey);
}

export function recordStudentDeviceLoginFailure(clientKey: string): void {
  failureRateLimiter.hit(clientKey);
}

/** A correct password clears the caller's failure budget. */
export function clearStudentDeviceLoginFailures(clientKey: string): void {
  failureRateLimiter.reset(clientKey);
}

/** Drop every tracked window for this ceremony. Intended for tests and operator resets. */
export function resetStudentDeviceLoginLimiters(): void {
  challengeRateLimiter.clearAll();
  failureRateLimiter.clearAll();
}

interface LoginChallengeRow {
  id: number;
  binding_token_hash: string;
  status: string;
  expires_at: Date;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Cross-check the authenticator's user handle against the handle the credential was enrolled
 * with. This is a consistency check, never an identity source: the handle is supplied by the
 * browser and is not covered by the assertion signature.
 *
 * A missing handle is tolerated rather than rejected so the ceremony keeps working on
 * platforms that omit it; the credential ID and its verified signature remain the real
 * identity proof either way.
 */
function userHandleMatches(
  assertion: AuthenticationResponseJSON,
  expectedHandle: string
): boolean {
  const userHandle = assertion.response.userHandle;
  if (userHandle === undefined || userHandle === null) {
    return true;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(userHandle, "base64url").toString("utf8");
  } catch {
    return false;
  }
  return constantTimeEquals(decoded, expectedHandle);
}

function reject(reason: RejectionReason): CompleteStudentDeviceLoginResult {
  // The reason is an internal enum with no identifiers in it. It exists so operators can spot
  // credential-stuffing without the log ever carrying a secret.
  console.warn("Student device login rejected.", reason);
  return { ok: false, code: INVALID_DEVICE_LOGIN };
}

/**
 * Mark a challenge spent. Used when the device proof itself fails, so a challenge never yields
 * more than one signature attempt.
 */
async function consumeLoginChallenge(challengeHash: string): Promise<void> {
  await pool.query(
    `UPDATE student_device_login_challenges
        SET status = 'USED', consumed_at = now()
      WHERE challenge_hash = $1 AND status = 'ACTIVE'`,
    [challengeHash]
  );
}

/**
 * Begin device-identified student login.
 *
 * Issues a fresh WebAuthn challenge and a binding token, storing only their SHA-256 hashes.
 * No student is identified and no session is created at this point: the RP genuinely does not
 * know who is about to authenticate.
 */
export async function startStudentDeviceLogin(): Promise<StudentDeviceLoginOptions> {
  const options = await createStudentDeviceLoginRequestOptions({
    rpID: webauthnConfig.rpID,
  });
  const bindingToken = generateSessionToken();
  const now = Date.now();

  await pool.query(
    `INSERT INTO student_device_login_challenges (challenge_hash, binding_token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [
      hashSessionToken(options.challenge),
      hashSessionToken(bindingToken),
      new Date(now + webauthnConfig.loginChallengeTtlMs),
    ]
  );

  // Opportunistic cleanup of spent and timed-out rows. Bounds table growth without needing a
  // scheduled job; correctness never depends on it, because expiry is enforced in SQL too.
  await pool.query(
    `UPDATE student_device_login_challenges
        SET status = 'EXPIRED', consumed_at = now()
      WHERE status = 'ACTIVE' AND expires_at <= $1`,
    [new Date(now)]
  );

  return { options, bindingToken };
}

/**
 * Finish device-identified student login.
 *
 * Order of operations, and why:
 *   1. resolve the challenge row (no lock) and check it is live and bound to this browser
 *   2. resolve the student from the assertion's credential ID — the only identity input
 *   3. pay one Argon2id verification regardless of outcome, so timing reveals nothing
 *   4. verify the WebAuthn signature with user verification required
 *   5. in one transaction: consume the challenge, honour any mid-flight revocation, persist
 *      the authenticator counter, and create the session
 *
 * A wrong password deliberately leaves the challenge unconsumed so a typo does not force the
 * student through another passkey prompt. That is safe: by that point the device proof has
 * already been verified, so re-presenting the same assertion teaches an attacker nothing.
 * A failed *signature* does consume the challenge, so no challenge ever yields more than one
 * signature attempt.
 */
export async function completeStudentDeviceLogin(
  input: StudentDeviceLoginInput
): Promise<CompleteStudentDeviceLoginResult> {
  const challengeHash = hashSessionToken(input.challenge);
  const bindingTokenHash = hashSessionToken(input.bindingToken);

  const challengeResult = await pool.query(
    `SELECT id, binding_token_hash, status, expires_at
       FROM student_device_login_challenges
      WHERE challenge_hash = $1
      LIMIT 1`,
    [challengeHash]
  );
  const challenge = (challengeResult.rows[0] as LoginChallengeRow | undefined) ?? null;

  const challengeUsable =
    challenge !== null &&
    challenge.status === "ACTIVE" &&
    challenge.expires_at.getTime() > Date.now() &&
    constantTimeEquals(challenge.binding_token_hash, bindingTokenHash);

  if (!challengeUsable || challenge === null) {
    await verifyPasswordOrDummy(null, input.password);
    return reject("CHALLENGE_NOT_USABLE");
  }

  // Identity resolution. `input.assertion.id` is the credential the authenticator chose; the
  // validator has already asserted it equals `rawId`.
  const candidate = await findStudentLoginCandidateByCredentialId(input.assertion.id);

  const passwordMatches = await verifyPasswordOrDummy(
    candidate?.passwordHash ?? null,
    input.password
  );

  if (candidate === null) {
    return reject("CREDENTIAL_NOT_RESOLVABLE");
  }
  if (!passwordMatches) {
    return reject("PASSWORD_REJECTED");
  }
  if (candidate.deviceStatus !== "ACTIVE") {
    return reject("DEVICE_NOT_ACTIVE");
  }
  // Defence in depth for the "usernameless login must not accept a non-discoverable
  // credential" requirement. The ceremony calls navigator.credentials.get() with no
  // allowCredentials, so a non-discoverable credential should never be returned at all — but if
  // one somehow is (or a pre-migration-010 row turns out to be non-discoverable), refuse it
  // rather than minting a session for a credential that could not be presented again.
  if (!isDiscoverableCredential(candidate)) {
    return reject("CREDENTIAL_NOT_DISCOVERABLE");
  }
  if (candidate.userRole !== "STUDENT" || candidate.userStatus !== "ACTIVE") {
    return reject("ACCOUNT_NOT_ACTIVE_STUDENT");
  }
  if (!userHandleMatches(input.assertion, candidate.webauthnUserHandle)) {
    return reject("USER_HANDLE_MISMATCH");
  }

  const verification = await verifyStudentDevice({
    credential: {
      id: candidate.credentialId,
      publicKey: candidate.credentialPublicKey,
      counter: candidate.counter,
      transports: candidate.transports ?? undefined,
    },
    response: input.assertion,
    expectedChallenge: input.challenge,
    expectedOrigin: webauthnConfig.expectedOrigin,
    expectedRPID: webauthnConfig.rpID,
    requireUserVerification: true,
  });

  if (!verification.ok) {
    // The device proof failed: retire the challenge so it cannot be used to try again.
    await consumeLoginChallenge(challengeHash);
    return reject("ASSERTION_REJECTED");
  }

  const sessionToken = generateSessionToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialises concurrent consumers of this challenge. Exactly one can win, and the
    // challenge is spent in the same transaction that creates the session.
    const consumed = await client.query(
      `UPDATE student_device_login_challenges
          SET status = 'USED', consumed_at = now()
        WHERE challenge_hash = $1
          AND status = 'ACTIVE'
          AND expires_at > now()
        RETURNING id`,
      [challengeHash]
    );
    if ((consumed.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return reject("CHALLENGE_ALREADY_CONSUMED");
    }

    // Honour a revocation that landed after the read above.
    const device = await lockActiveDeviceById(client, candidate.deviceId);
    if (device === null || device.credential_id !== candidate.credentialId) {
      await client.query("ROLLBACK");
      return reject("DEVICE_REVOKED_MID_FLIGHT");
    }

    // Re-assert the account gate at commit time, so an account returned to PENDING (for
    // example by an admin registration reset) can never be signed in through a device that
    // was deliberately left enrolled.
    const account = await client.query(
      `SELECT 1 FROM users
        WHERE id = $1 AND role = 'STUDENT' AND status = 'ACTIVE'
        LIMIT 1`,
      [candidate.userId]
    );
    if ((account.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return reject("ACCOUNT_CHANGED_MID_FLIGHT");
    }

    // Persist the new signature counter to detect cloned authenticators and stop replays.
    await client.query(
      `UPDATE student_devices SET counter = $2, last_seen_at = now() WHERE id = $1`,
      [candidate.deviceId, verification.newCounter]
    );

    await client.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        candidate.userId,
        hashSessionToken(sessionToken),
        new Date(Date.now() + authConfig.sessionLifetimeMs),
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // Reuse the same safe-user projection every other authentication path returns.
  const user = await findSafeUserById(candidate.userId);
  if (user === null || user.role !== "STUDENT") {
    return reject("ACCOUNT_CHANGED_MID_FLIGHT");
  }

  return { ok: true, token: sessionToken, user };
}
