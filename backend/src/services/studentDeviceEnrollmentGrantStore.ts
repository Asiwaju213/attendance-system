import type { PoolClient } from "pg";
import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";

/**
 * Persistence and lifecycle for student device enrollment grants.
 *
 * An enrollment grant is what a matric number + password login returns to a browser that has no
 * device binding, when the student has no ACTIVE device. It authorizes exactly the three
 * device-enrollment operations and nothing else: it is never accepted by `requireAuth`, and it
 * cannot reach a normal student API. The normal `oou_session` is minted only once the WebAuthn
 * ceremony commits.
 *
 * The grant token itself never touches this module's callers except at issue time: everything
 * here works from the SHA-256 hash, so the raw value is never logged, never returned to a
 * storage layer, and never recoverable from a database read.
 *
 * @see database/migrations/011_student_device_enrollment_grants.sql
 */

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
 * The identity a grant authorizes, resolved from the stored row.
 *
 * Only what the enrollment code needs is exposed: the user id to read the student profile and the
 * student id to bind WebAuthn challenges to. No credential, device or grant identifier crosses
 * this boundary.
 */
export interface EnrollmentGrantIdentity {
  studentId: number;
  userId: number;
}

export type ResolveEnrollmentGrantResult =
  | { ok: true; studentId: number; userId: number }
  | { ok: false; code: "INVALID_GRANT" };

export type IssueEnrollmentGrantResult =
  | { ok: true; grantToken: string }
  | { ok: false; code: "ISSUE_FAILED" };

/**
 * Mark every ACTIVE grant for a student as EXPIRED.
 *
 * Called before issuing a replacement so that one student can never hold two live grants. The
 * partial unique index `one_active_enrollment_grant_per_student` enforces the same invariant at
 * the database level; this call exists so the loser of a race simply supersedes the winner
 * instead of failing the request.
 */
export async function expireActiveEnrollmentGrants(
  studentId: number,
  client: Pick<PoolClient, "query"> = pool
): Promise<void> {
  await client.query(
    `UPDATE student_device_enrollment_grants
        SET status = 'EXPIRED', updated_at = now()
      WHERE student_id = $1 AND status = 'ACTIVE'`,
    [studentId]
  );
}

/**
 * Issue a fresh enrollment grant for a student.
 *
 * Any earlier unconsumed grant for the same student is expired first, so re-entering the matric
 * number on the login page always yields exactly one usable grant.
 *
 * The returned token is the only time the raw value exists outside the browser. Callers must hand
 * it straight to the response cookie and must never log it.
 */
export async function issueEnrollmentGrant(
  studentId: number
): Promise<IssueEnrollmentGrantResult> {
  const grantToken = generateSessionToken();
  const grantHash = hashSessionToken(grantToken);
  const expiresAt = new Date(Date.now() + authConfig.enrollmentGrantLifetimeMs);

  // Bounded like the enrollment-challenge issuance loop: a unique violation can only come from a
  // concurrent issuance for the same student, and retrying after expiring the other row resolves
  // it. Anything else is a real error and must not be swallowed.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expireActiveEnrollmentGrants(studentId, client);
      await client.query(
        `INSERT INTO student_device_enrollment_grants (student_id, grant_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [studentId, grantHash, expiresAt]
      );
      await client.query("COMMIT");
      return { ok: true, grantToken };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error) && attempt < maxAttempts) {
        continue;
      }
      console.error(
        "Enrollment grant issuance failed.",
        (error as Error).message
      );
      return { ok: false, code: "ISSUE_FAILED" };
    } finally {
      client.release();
    }
  }
  return { ok: false, code: "ISSUE_FAILED" };
}

/**
 * Resolve a raw grant token to the student it is bound to.
 *
 * Only ACTIVE, unexpired, unconsumed rows resolve. Every other outcome — unknown token, spent
 * token, revoked token, expired row — collapses to the same `INVALID_GRANT`, so this cannot be
 * used to probe which grants exist.
 *
 * Read-only on purpose: resolution must not consume the grant, because the enrollment ceremony
 * may be abandoned and retried. Consumption happens once, at the end, on success.
 */
export async function resolveEnrollmentGrant(
  grantToken: string
): Promise<ResolveEnrollmentGrantResult> {
  if (typeof grantToken !== "string" || grantToken.trim() === "") {
    return { ok: false, code: "INVALID_GRANT" };
  }

  const result = await pool.query(
    `SELECT g.student_id,
            u.id AS user_id
       FROM student_device_enrollment_grants g
       JOIN students s ON s.id = g.student_id
       JOIN users u ON u.id = s.user_id
      WHERE g.grant_hash = $1
        AND g.status = 'ACTIVE'
        AND g.expires_at > now()
        AND u.role = 'STUDENT'
        AND u.status = 'ACTIVE'
      LIMIT 1`,
    [hashSessionToken(grantToken.trim())]
  );

  const row = result.rows[0];
  if (!row) {
    return { ok: false, code: "INVALID_GRANT" };
  }

  return {
    ok: true,
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
  };
}

/**
 * Atomically consume a grant.
 *
 * The conditional `UPDATE ... WHERE status = 'ACTIVE' AND expires_at > now()` is the single-use
 * guarantee: of two concurrent enrollment completions, exactly one observes a non-zero
 * `rowCount`. A grant that expired between resolution and completion is consumed as `EXPIRED`,
 * also with rowCount zero, so it cannot be replayed.
 *
 * Returns true only for the caller that won the race.
 */
export async function consumeEnrollmentGrant(grantToken: string): Promise<boolean> {
  if (typeof grantToken !== "string" || grantToken.trim() === "") {
    return false;
  }

  const result = await pool.query(
    `UPDATE student_device_enrollment_grants
        SET status = CASE WHEN expires_at > now() THEN 'USED' ELSE 'EXPIRED' END,
            consumed_at = now(),
            updated_at = now()
      WHERE grant_hash = $1
        AND status = 'ACTIVE'
        AND expires_at > now()
      RETURNING id`,
    [hashSessionToken(grantToken.trim())]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Test/diagnostic helper: read a grant row by student, without ever exposing the token.
 *
 * Returns the stored status and timestamps only, so it is safe to assert on in tests.
 */
export async function readEnrollmentGrantForStudent(
  studentId: number
): Promise<{
  status: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
} | null> {
  const result = await pool.query(
    `SELECT status, created_at, expires_at, consumed_at
       FROM student_device_enrollment_grants
      WHERE student_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [studentId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
  };
}
