import { NextFunction, Request, Response } from "express";
import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import { hashSessionToken } from "../lib/sessions";
import { getCookieValue } from "./authenticate";

/**
 * One indexed lookup answers the only question this guard asks: does the session cookie
 * presented with this request belong to an ACTIVE lecturer that still owes a forced password
 * change?
 *
 * Scoped to LECTURER on purpose. The flag is only ever set on an account created through the
 * admin lecturer endpoint, so admin and student sessions can never match it and their
 * authorization is untouched.
 */
const PENDING_CHANGE_QUERY = `
  SELECT u.must_change_password
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.session_token_hash = $1
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND u.status = 'ACTIVE'
    AND u.role = 'LECTURER'
  LIMIT 1`;

/**
 * Deny every API surface except the auth router while a forced password change is pending.
 *
 * Mounted in `app.ts` after `/api/auth`, which is what makes the restriction complete rather
 * than advisory: `/api/auth/me`, `/api/auth/change-password` and `/api/auth/logout` are
 * matched before this runs, while every admin, lecturer and student route is reached after it.
 * A lecturer who has not changed the temporary password therefore cannot read or change any
 * attendance data, and cannot reach an admin or student endpoint either, no matter which URL
 * the client asks for.
 */
export async function requirePasswordChangeCleared(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getCookieValue(req, authConfig.cookieName);
  if (!token) {
    // No user session cookie: this is an unauthenticated request, or a machine-to-machine one
    // such as the edge sync transport. The route's own guard decides whether that is allowed.
    next();
    return;
  }

  try {
    const result = await pool.query(PENDING_CHANGE_QUERY, [hashSessionToken(token)]);
    const row = result.rows[0] as { must_change_password?: boolean } | undefined;
    if (row?.must_change_password === true) {
      res.status(403).json({
        error: "PASSWORD_CHANGE_REQUIRED",
        message:
          "You must change your temporary password before you can use the system.",
      });
      return;
    }
    next();
  } catch (error) {
    // Fail open here on purpose. Every route this guard covers authenticates against the same
    // database and would fail on the same outage anyway, and blocking unconditionally would
    // also break the machine-to-machine sync transport, which carries no session cookie.
    console.error(
      "Forced password change check failed.",
      (error as Error).message
    );
    next();
  }
}
