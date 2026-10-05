import type { Application, NextFunction, Request, Response } from "express";
import {
  DEFAULT_STUDENT_ACCESS_MODE,
  STUDENT_ACCESS_MODE_SETTING,
  type StudentAccessMode,
  studentAccessEnabled,
} from "../config/access";

/**
 * The single server-side policy that decides whether a student may use this deployment.
 *
 * Why this exists
 * ---------------
 * Authorization in this codebase answers "who are you?" and never "where are you?". Every student
 * entry point in routes/auth.ts and every student router checked only the session's role, so the
 * same build served students identically from the campus LAN and from the public Internet. There
 * was no policy to bypass - the public path was simply never closed.
 *
 * What this does
 * --------------
 * Two entry points, both driven by the resolved deployment mode (config/access.ts) and nothing
 * else. No `req.ip`, no `X-Forwarded-For`, no host or port inspection: on the deployed topology
 * the client address is a proxy address, and a client-influenceable header must never decide who
 * may sign in.
 *
 * It deliberately does not touch WebAuthn, passwords, sessions or role checks. A blocked student
 * request is refused before any credential is examined, and an allowed one continues through the
 * existing authentication and authorization exactly as before.
 */

/** Error code returned for every request this policy refuses. */
export const STUDENT_ACCESS_DISABLED = "STUDENT_ACCESS_DISABLED";

const MESSAGE =
  "Student sign-in and student data are not available on this deployment. " +
  "They are served by the K12 campus network deployment only.";

/**
 * The mode in force for the app handling this request.
 *
 * Stored as an Express application setting rather than read from a module-level constant so the
 * same middleware can serve both modes in one process, which is what lets the tests exercise cloud
 * and edge behaviour through the real routers instead of a stand-in.
 *
 * Fails closed: anything other than the exact string `edge` means students are off. An app that
 * was never configured therefore refuses students.
 */
export function resolveRequestStudentAccessMode(app: Application): StudentAccessMode {
  const configured = app.get(STUDENT_ACCESS_MODE_SETTING);
  if (configured === "edge") {
    return "edge";
  }
  if (configured === "cloud") {
    return "cloud";
  }
  return DEFAULT_STUDENT_ACCESS_MODE;
}

function refuse(res: Response): void {
  res.status(403).json({ error: STUDENT_ACCESS_DISABLED, message: MESSAGE });
}

/**
 * Whether this request targets a student-specific path.
 *
 * Evaluated against `req.path`, which inside a middleware mounted at `/api/auth` is the path
 * relative to that mount: `/student/login`, `/student/device/verify`,
 * `/student/register/complete`, `/student/remembered`, `/student/device-binding`.
 *
 * Matching on the `/student` segment rather than listing endpoints is deliberate: a student route
 * added later is covered by the policy automatically instead of silently becoming public.
 */
function isStudentAuthPath(req: Request): boolean {
  return req.path === "/student" || req.path.startsWith("/student/");
}

/**
 * Guards the student-specific half of `/api/auth`.
 *
 * Mounted in front of the auth router. In cloud mode it refuses every `/student*` auth path with
 * 403, which covers password sign-in, the WebAuthn device options/verify pair, and registration -
 * without which no student session can be minted here at all.
 *
 * `/auth/me`, `/auth/logout`, `/auth/change-password`, `/auth/lecturer/login` and
 * `/auth/admin/login` do not match the predicate and continue untouched, so staff keep working
 * over the Internet.
 */
export function rejectStudentAccessInCloud(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (studentAccessEnabled(resolveRequestStudentAccessMode(req.app))) {
    next();
    return;
  }
  if (!isStudentAuthPath(req)) {
    next();
    return;
  }
  refuse(res);
}

/**
 * Guards the whole `/api/student` API surface.
 *
 * Mounted ahead of the student routers, so in cloud mode a student session cannot reach
 * attendance, attendance history, course registration or device APIs by calling them directly -
 * the case a login-only check would miss, because such a session was created on the edge, or
 * before this policy existed, and carries a perfectly valid cookie.
 *
 * This runs before `requireAuth`, so a cloud deployment answers 403 for every caller rather than
 * 401 for anonymous ones and 403 only for students, which keeps the response uniform. The role
 * check is untouched: in edge mode this is a no-op and `requireStudent` still decides.
 */
export function requireStudentAccess(req: Request, res: Response, next: NextFunction): void {
  if (studentAccessEnabled(resolveRequestStudentAccessMode(req.app))) {
    next();
    return;
  }
  refuse(res);
}
