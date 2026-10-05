import express, { Express, NextFunction, Request, Response } from "express";
import { STUDENT_ACCESS_MODE_SETTING, studentAccessConfig, type StudentAccessMode } from "./config/access";
import { applyTrustProxy } from "./config/trustProxy";
import { pool } from "./db/pool";
import adminAcademicSessionsRouter from "./routes/adminAcademicSessions";
import adminAttendanceRecordsRouter from "./routes/adminAttendanceRecords";
import adminAttendanceReportsRouter from "./routes/adminAttendanceReports";
import adminAttendanceSessionsRouter from "./routes/adminAttendanceSessions";
import adminCourseOfferingsRouter from "./routes/adminCourseOfferings";
import adminCoursesRouter from "./routes/adminCourses";
import adminLecturersRouter from "./routes/adminLecturers";
import adminOrganizationRouter from "./routes/adminOrganization";
import adminSemestersRouter from "./routes/adminSemesters";
import adminStudentImportRouter from "./routes/adminStudentImport";
import adminStudentDevicesRouter from "./routes/adminStudentDevices";
import adminStudentsRouter from "./routes/adminStudents";
import adminSyncStatusRouter from "./routes/adminSyncStatus";
import authRouter from "./routes/auth";
import { requirePasswordChangeCleared } from "./middleware/passwordChangeGuard";
import {
  rejectStudentAccessInCloud,
  requireStudentAccess,
  resolveRequestStudentAccessMode,
} from "./middleware/studentAccess";
import lecturerAttendanceReportsRouter from "./routes/lecturerAttendanceReports";
import lecturerAttendanceSessionsRouter from "./routes/lecturerAttendanceSessions";
import lecturerCatalogRouter from "./routes/lecturerCatalog";
import studentAttendanceHistoryRouter from "./routes/studentAttendanceHistory";
import studentAttendanceRouter from "./routes/studentAttendance";
import studentDeviceRouter from "./routes/studentDevice";
import studentRegistrationRouter from "./routes/studentRegistration";
import internalSyncRouter from "./routes/internalSync";

export interface AppOptions {
  /**
   * Override the deployment mode for this app instance.
   *
   * Production always uses the value resolved from STUDENT_ACCESS_MODE (see config/access.ts).
   * This exists so the tests can mount the real routers in both modes inside one process, rather
   * than standing up a separate server per mode or mutating process.env. It is never set by
   * index.ts.
   */
  studentAccessMode?: StudentAccessMode;
}

/**
 * Build the application.
 *
 * A factory rather than a module-level singleton so a test can obtain one app in `cloud` mode and
 * one in `edge` mode and drive the actual route stack in each. `app` below is still the instance
 * the server listens on and the one every existing test imports.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // The mode is an Express application setting, so middleware reads it per request rather than
  // capturing a module-level constant. Unset means the fail-closed default (students disabled).
  app.set(STUDENT_ACCESS_MODE_SETTING, options.studentAccessMode ?? studentAccessConfig.mode);

  // Before any middleware or route can read `req.ip`. Exactly one reverse-proxy
  // hop (Vercel's edge) is trusted; see config/trustProxy.ts.
  applyTrustProxy(app);

  app.use(express.json());

  app.get("/api/health", async (_req, res) => {
    let databaseStatus = "connected";

    try {
      await pool.query("SELECT NOW()");
    } catch (error) {
      console.error("Database health check failed.", (error as Error).message);
      databaseStatus = "unavailable";
    }

    const statusCode = databaseStatus === "connected" ? 200 : 503;

    res.status(statusCode).json({
      status: databaseStatus === "connected" ? "ok" : "degraded",
      message: "OOU Attendance System API is running",
      database: databaseStatus,
      // Which deployment this process believes it is, so an operator can confirm a K12 PC is in
      // edge mode (and a cloud service is not) without reading its environment variables. One
      // word, no addresses, no secrets.
      studentAccessMode: resolveRequestStudentAccessMode(app),
      timestamp: new Date().toISOString(),
    });
  });

  // Student sign-in policy, ahead of the auth router. See middleware/studentAccess.ts.
  // In cloud mode this refuses /api/auth/student/* and nothing else: staff sign-in, /auth/me,
  // /auth/logout and the forced password change all keep working over the Internet.
  app.use("/api/auth", rejectStudentAccessInCloud);
  app.use("/api/auth", authRouter);
  // Forced password change. Mounted after the auth router and before every role router, so a
  // lecturer who still owes a change can reach exactly `/api/auth/me`,
  // `/api/auth/change-password` and `/api/auth/logout` and nothing else - no admin route, no
  // student route, no lecturer route, whatever the client asks for. Requests without a session
  // cookie (including the machine-to-machine sync transport below) are unaffected.
  app.use(requirePasswordChangeCleared);
  app.use("/api/admin", adminAcademicSessionsRouter);
  app.use("/api/admin", adminSemestersRouter);
  app.use("/api/admin", adminOrganizationRouter);
  app.use("/api/admin", adminCoursesRouter);
  app.use("/api/admin", adminLecturersRouter);
  app.use("/api/admin", adminCourseOfferingsRouter);
  app.use("/api/admin", adminStudentImportRouter);
  app.use("/api/admin", adminStudentDevicesRouter);
  app.use("/api/admin", adminStudentsRouter);
  app.use("/api/admin", adminSyncStatusRouter);
  app.use("/api/admin", adminAttendanceSessionsRouter);
  app.use("/api/admin", adminAttendanceRecordsRouter);
  app.use("/api/admin", adminAttendanceReportsRouter);
  // The same policy in front of the student API surface, so an existing student session - minted on
  // the edge, or before this policy existed - cannot reach attendance, history, registration or
  // device APIs on the public deployment either. `requireStudent` still applies behind it.
  app.use("/api/student", requireStudentAccess);
  app.use("/api/student", studentRegistrationRouter);
  app.use("/api/student", studentDeviceRouter);
  app.use("/api/student", studentAttendanceHistoryRouter);
  app.use("/api/student", studentAttendanceRouter);
  app.use("/api/lecturer", lecturerCatalogRouter);
  app.use("/api/lecturer", lecturerAttendanceSessionsRouter);
  app.use("/api/lecturer", lecturerAttendanceReportsRouter);

  // Cloud -> local K12 edge synchronization. Mounted on its own prefix, outside
  // every role router, and guarded by its own edge-credential middleware rather
  // than `requireAuth` - it must never be reachable with a user session.
  // This prefix is also where the edge -> cloud attendance upload lives, so it is
  // both sides' transport. The machine credential in one direction and the user
  // session in the other are never interchangeable.
  app.use("/api/internal/sync", internalSyncRouter);

  // Centralized error handler: never leak internal details to clients.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled request error.", err.message);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
  });

  return app;
}

/** The application instance the HTTP server listens on. */
export const app = createApp();
