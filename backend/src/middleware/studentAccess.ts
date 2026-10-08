import type { Application, NextFunction, Request, Response } from "express";
import {
  DEFAULT_STUDENT_ACCESS_MODE,
  STUDENT_ACCESS_MODE_SETTING,
  type StudentAccessMode,
  studentAccessEnabled,
} from "../config/access";

/**
 * The single server-side policy that decides which student surfaces a deployment may serve.
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
 * The two modes split the student surface by deployment:
 *
 *   cloud  - account setup only. A newly registered student can complete course registration and
 *            WebAuthn device enrollment, but can never sign in and can never mark or read
 *            attendance.
 *   edge   - the full student surface: sign-in and every student API, exactly as before.
 *
 * The cloud allowlists live in this one file, so a single review point defines what the public
 * deployment serves and the routers stay free of deployment logic. Both lists are allowlists
 * rather than denylists: a student route added later defaults to refused on the cloud until it is
 * allowed here on purpose.
 *
 * It deliberately does not touch WebAuthn, passwords, sessions or role checks. A refused request
 * is stopped before any credential is examined, and an allowed one continues through the existing
 * authentication and authorization exactly as before.
 */

/** Error code returned for every request this policy refuses. */
export const STUDENT_ACCESS_DISABLED = "STUDENT_ACCESS_DISABLED";

const MESSAGE =
  "Student sign-in and attendance are not available on this deployment. " +
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
 * added later is considered against the policy automatically. On the edge that means it is simply
 * served (edge lets everything through); on the cloud it stays refused until explicitly added to
 * the allowlists below.
 */
function isStudentAuthPath(req: Request): boolean {
  return req.path === "/student" || req.path.startsWith("/student/");
}

/**
 * The `/api/auth` paths the cloud deployment may serve: student account registration and nothing
 * else.
 *
 * `/student/register/verify` and `/student/register/complete` are the whole current registration
 * flow (services/studentRegistrationService.ts). Matched exactly, not by prefix, so a
 * registration path added later also stays refused on the public deployment until it is added
 * here on purpose. Login, device login, bootstrap, remembered-account and device-binding all stay
 * refused.
 */
function isCloudStudentAuthPath(req: Request): boolean {
  return req.path === "/student/register/verify" || req.path === "/student/register/complete";
}

/**
 * The `/api/student` paths the cloud deployment may serve: the student-management surfaces a newly
 * registered student needs to finish setting the account up - course registration
 * (`/registration/*`, `/course-registrations`) and WebAuthn device enrollment (`/device`,
 * `/device/*`).
 *
 * Every other `/api/student` path is refused on the cloud: attendance marking, attendance
 * eligibility, attendance device challenges, attendance history, and anything added later. The
 * allowlist - not a denylist - is what keeps that fail-closed: a student route added tomorrow
 * defaults to 403 on the public deployment until it is allowed here on purpose.
 */
function isCloudStudentApiPath(req: Request): boolean {
  return (
    req.path === "/registration" ||
    req.path.startsWith("/registration/") ||
    req.path === "/course-registrations" ||
    req.path === "/device" ||
    req.path.startsWith("/device/")
  );
}

/**
 * Guards the student-specific half of `/api/auth`.
 *
 * Mounted in front of the auth router. In cloud mode it lets only the registration pair
 * (`/student/register/verify`, `/student/register/complete`) through and refuses every other
 * `/student*` auth path with 403 - password sign-in, the WebAuthn device login options/verify
 * pair, device bootstrap, the remembered-account endpoints and device-binding.
 *
 * `/auth/me`, `/auth/logout`, `/auth/change-password`, `/auth/lecturer/login` and
 * `/auth/admin/login` do not match the predicate and continue untouched, so staff keep working
 * over the Internet. In edge mode the whole auth router is served as before.
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
  if (isCloudStudentAuthPath(req)) {
    next();
    return;
  }
  refuse(res);
}

/**
 * Guards the whole `/api/student` API surface.
 *
 * Mounted ahead of the student routers, so in cloud mode a student session cannot reach the
 * attendance or attendance-history APIs by calling them directly - the case a login-only check
 * would miss, because such a session was created on the edge, or before this policy existed, and
 * carries a perfectly valid cookie. Course registration and device enrollment remain reachable in
 * cloud mode, which is what lets a newly registered student finish setting the account up.
 *
 * This runs before `requireAuth`, so a cloud deployment answers 403 for the refused surfaces
 * rather than 401 for anonymous ones and 403 only for students, which keeps the response uniform.
 * The role check is untouched: in edge mode this is a no-op and `requireStudent` still decides.
 */
export function requireStudentAccess(req: Request, res: Response, next: NextFunction): void {
  if (studentAccessEnabled(resolveRequestStudentAccessMode(req.app))) {
    next();
    return;
  }
  if (isCloudStudentApiPath(req)) {
    next();
    return;
  }
  refuse(res);
}
