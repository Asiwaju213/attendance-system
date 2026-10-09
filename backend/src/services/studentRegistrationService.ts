import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";
import { SafeUser } from "../types/auth";
import { RegistrationIdentityPreview } from "../types/studentRegistration";
import { findSafeUserById } from "./userStore";

export const REGISTRATION_CHALLENGE_LIFETIME_MS = 15 * 60 * 1000;

export type RegistrationVerifyErrorCode = "STUDENT_NOT_FOUND";
export type RegistrationCompleteErrorCode =
  | "INVALID_REGISTRATION_CHALLENGE"
  | "ALREADY_REGISTERED";

export type RegistrationVerifyResult =
  | { ok: true; data: RegistrationIdentityPreview }
  | { ok: false; code: RegistrationVerifyErrorCode };

export type RegistrationCompleteResult =
  | { ok: true; token: string; user: SafeUser }
  | { ok: false; code: RegistrationCompleteErrorCode };

interface PendingStudentRow {
  user_id: number;
  name: string;
  matric_number: string;
  department_id: number;
  department_name: string;
  department_code: string;
  level_id: number;
  level_name: number;
}

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
 * Find an account this matric number may claim by choosing a local password.
 *
 * Two eligibility paths, and the difference matters:
 *
 *   * `PENDING` + `password_hash IS NULL` - the original self-registration path for
 *     a bulk-imported student who has never signed in here.
 *   * `ACTIVE` + `password_hash IS NULL` + a live cloud-enrollment bootstrap - a
 *     student who was created and device-enrolled on the CLOUD and synchronized
 *     here. The local `users` row the applier writes has `password_hash = NULL`
 *     (migration 019's applier), so no password this edge could ever verify, and
 *     the student is left unable to sign in at all.
 *
 * `password_hash IS NULL` is the load-bearing condition on BOTH paths and is
 * checked on read and again on write. It is what stops this flow from being a way
 * to take over or re-key an account that already has a password, and it is what
 * makes the claim single-use.
 *
 * The bootstrap record is the eligibility marker, not an authentication: anyone
 * may name a matric number, so eligibility is deliberately narrow. `PENDING` and
 * unexpired means "a device the cloud enrolled for this student, whose secret is
 * still live" - the population that actually needs this path, and nothing wider.
 */
async function findPendingStudent(matricNumber: string): Promise<PendingStudentRow | null> {
  const result = await pool.query(
    `SELECT u.id AS user_id, u.name, s.matric_number,
            d.id AS department_id, d.name AS department_name, d.code AS department_code,
            l.id AS level_id, l.name AS level_name
       FROM students s
       JOIN users u ON u.id = s.user_id
       JOIN departments d ON d.id = s.department_id
       JOIN levels l ON l.id = s.level_id
      WHERE s.matric_number = $1
        AND u.role = 'STUDENT'
        AND u.password_hash IS NULL
        AND (
          u.status = 'PENDING'
          OR EXISTS (
            SELECT 1
              FROM sync_student_device_bootstraps b
             WHERE b.student_id = s.id
               AND b.status = 'PENDING'
               AND b.expires_at > now()
          )
        )
      LIMIT 1`,
    [matricNumber]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    user_id: Number(row.user_id),
    name: row.name,
    matric_number: row.matric_number,
    department_id: Number(row.department_id),
    department_name: row.department_name,
    department_code: row.department_code,
    level_id: Number(row.level_id),
    level_name: Number(row.level_name),
  };
}

async function issueChallenge(userId: number): Promise<string> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE student_registration_challenges
         SET status = 'EXPIRED', consumed_at = now()
         WHERE user_id = $1 AND status = 'ACTIVE'`,
        [userId]
      );
      await client.query(
        `INSERT INTO student_registration_challenges (user_id, challenge_token_hash)
         VALUES ($1, $2)`,
        [userId, tokenHash]
      );
      await client.query("COMMIT");
      return token;
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
  throw new Error("Could not issue a registration challenge.");
}

export async function verifyRegistration(
  matricNumber: string
): Promise<RegistrationVerifyResult> {
  const pending = await findPendingStudent(matricNumber);
  if (!pending) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }
  const challengeToken = await issueChallenge(pending.user_id);
  return {
    ok: true,
    data: {
      matricNumber: pending.matric_number,
      name: pending.name,
      department: {
        id: pending.department_id,
        name: pending.department_name,
        code: pending.department_code,
      },
      level: { id: pending.level_id, name: pending.level_name },
      challengeToken,
    },
  };
}

export async function completeRegistration(
  challengeToken: string,
  passwordHash: string
): Promise<RegistrationCompleteResult> {
  const challengeHash = hashSessionToken(challengeToken);

  const challengeResult = await pool.query(
    `SELECT id, user_id
     FROM student_registration_challenges
     WHERE challenge_token_hash = $1
       AND status = 'ACTIVE'
       AND created_at > now() - ($2 * interval '1 millisecond')
     LIMIT 1`,
    [challengeHash, REGISTRATION_CHALLENGE_LIFETIME_MS]
  );
  const challenge = challengeResult.rows[0];
  if (!challenge) {
    return { ok: false, code: "INVALID_REGISTRATION_CHALLENGE" };
  }
  const userId = Number(challenge.user_id);

  const sessionToken = generateSessionToken();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const consumed = await client.query(
      `UPDATE student_registration_challenges
       SET status = 'USED', consumed_at = now()
       WHERE id = $1 AND status = 'ACTIVE'
         AND created_at > now() - ($2 * interval '1 millisecond')
       RETURNING id`,
      [challenge.id, REGISTRATION_CHALLENGE_LIFETIME_MS]
    );
    if (consumed.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "INVALID_REGISTRATION_CHALLENGE" };
    }

    // The password is written by a single guarded UPDATE, so the claim is
    // single-use without depending on the caller: `password_hash IS NULL` means an
    // account that already has a local password can never be re-keyed from here,
    // no matter how many challenges were issued for it. Two concurrent
    // completions therefore serialize on the row lock, the winner writes, and the
    // loser re-evaluates the predicate against the committed row and matches
    // nothing.
    //
    // The same eligibility the challenge was issued under is re-checked in the
    // same statement, because a challenge is a nonce rather than a proof: the
    // eligibility conditions may have changed between issuance and completion
    // (an admin set a password, the last live bootstrap was spent or expired).
    // Trusting the issuance decision alone would let a stale challenge set a
    // password on an account that is no longer eligible.
    //
    // `SET status = 'ACTIVE'` is the whole of the PENDING path's activation and a
    // no-op write for a student who is already ACTIVE, so both paths converge on
    // one statement.
    const activated = await client.query(
      `UPDATE users u
        SET status = 'ACTIVE', password_hash = $2
       WHERE u.id = $1
         AND u.password_hash IS NULL
         AND (
           u.status = 'PENDING'
           OR EXISTS (
             SELECT 1
               FROM students s
               JOIN sync_student_device_bootstraps b ON b.student_id = s.id
              WHERE s.user_id = u.id
                AND b.status = 'PENDING'
                AND b.expires_at > now()
           )
         )
       RETURNING id`,
      [userId, passwordHash]
    );
    if (activated.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ALREADY_REGISTERED" };
    }

    await client.query(
      `INSERT INTO sessions (user_id, session_token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [
        userId,
        hashSessionToken(sessionToken),
        new Date(Date.now() + authConfig.sessionLifetimeMs),
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const user = await findSafeUserById(userId);
  if (!user) {
    return { ok: false, code: "ALREADY_REGISTERED" };
  }
  return { ok: true, token: sessionToken, user };
}