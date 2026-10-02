import type { Request } from "express";
import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import {
  resolveEnrollmentGrant,
  type EnrollmentGrantIdentity,
} from "../services/studentDeviceEnrollmentGrantStore";
import { getCookieValue } from "./authenticate";

/**
 * How an enrollment request proved who it is.
 *
 * The distinction matters for audit and for the session cookie: a `SESSION` request is an already
 * authenticated student managing their device, and keeps the session it arrived with. A `GRANT`
 * request is a student who has verified a matric number + password but has no session yet, and
 * receives a brand new one only once their ceremony commits.
 */
export type EnrollmentAuthMethod = "SESSION" | "GRANT";

export interface EnrollmentAuthContext extends EnrollmentGrantIdentity {
  method: EnrollmentAuthMethod;
  /**
   * The raw grant token, retained only so the caller can consume it on success. Never log it.
   */
  grantToken: string | null;
}

export type ResolveEnrollmentAuthResult =
  | { ok: true; auth: EnrollmentAuthContext }
  | { ok: false; code: "UNAUTHENTICATED" };

function unauthorized(): ResolveEnrollmentAuthResult {
  return { ok: false, code: "UNAUTHENTICATED" };
}

/**
 * Decide which student an enrollment request is acting for.
 *
 * Two accepted proofs, in priority order:
 *
 *   1. A normal `oou_session` (the existing behaviour for an enrolled student managing their
 *      device, and the only way to run the UPGRADE ceremony).
 *   2. A valid, unexpired enrollment grant. This exists so a student with no ACTIVE device can
 *      enrol their first one without ever holding a session.
 *
 * The two are mutually exclusive. If both cookies are present and they disagree about which
 * student they represent, neither is trusted: that combination can only arise from a stale grant
 * left over in a browser that has since signed in as somebody else, and honouring it would let a
 * signed-in student complete an enrollment ceremony as a different student. This is also the only
 * branch that needs an extra student lookup, and it runs only for a request that already carries
 * both cookies.
 *
 * Explicitly NOT here: acceptance of a grant by `requireAuth`. A grant authorizes the enrollment
 * operations and nothing else; no normal student API will ever read one.
 */
export async function resolveEnrollmentAuth(
  req: Request
): Promise<ResolveEnrollmentAuthResult> {
  const grantToken = getCookieValue(req, authConfig.enrollmentGrantCookieName);

  if (req.user) {
    if (!grantToken || grantToken.trim() === "") {
      return {
        ok: true,
        auth: { userId: req.user.id, studentId: 0, method: "SESSION", grantToken: null },
      };
    }

    const grant = await resolveEnrollmentGrant(grantToken);
    if (!grant.ok) {
      // The session is sound and the grant is dead. Prefer the session: an expired grant must not
      // lock a returning student out of their own device page.
      return {
        ok: true,
        auth: { userId: req.user.id, studentId: 0, method: "SESSION", grantToken: null },
      };
    }

    const sessionStudentId = await findStudentIdForUser(req.user.id);
    if (sessionStudentId === null) {
      return unauthorized();
    }
    if (sessionStudentId !== grant.studentId) {
      return unauthorized();
    }

    return {
      ok: true,
      auth: {
        userId: req.user.id,
        studentId: sessionStudentId,
        method: "SESSION",
        // Keep the grant so a successful ceremony still spends it exactly once.
        grantToken,
      },
    };
  }

  if (!grantToken || grantToken.trim() === "") {
    return unauthorized();
  }

  const grant = await resolveEnrollmentGrant(grantToken);
  if (!grant.ok) {
    return unauthorized();
  }

  return {
    ok: true,
    auth: {
      userId: grant.userId,
      studentId: grant.studentId,
      method: "GRANT",
      grantToken,
    },
  };
}

/**
 * Map a user id to their student profile id.
 *
 * Kept local rather than imported from the device store so this middleware has no dependency on
 * the device tables at all: it is about proving identity, not about devices.
 */
async function findStudentIdForUser(userId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}
