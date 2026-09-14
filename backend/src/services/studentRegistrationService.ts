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
       AND u.status = 'PENDING'
       AND u.password_hash IS NULL
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

    const activated = await client.query(
      `UPDATE users
       SET status = 'ACTIVE', password_hash = $2
       WHERE id = $1 AND status = 'PENDING' AND password_hash IS NULL
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