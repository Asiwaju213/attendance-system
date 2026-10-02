import express, { NextFunction, Request, Response } from "express";
import { applyTrustProxy } from "./config/trustProxy";
import { pool } from "./db/pool";
import adminAcademicSessionsRouter from "./routes/adminAcademicSessions";
import adminAttendanceNetworksRouter from "./routes/adminAttendanceNetworks";
import adminAttendanceRecordsRouter from "./routes/adminAttendanceRecords";
import adminAttendanceReportsRouter from "./routes/adminAttendanceReports";
import adminAttendanceSessionsRouter from "./routes/adminAttendanceSessions";
import adminCourseOfferingsRouter from "./routes/adminCourseOfferings";
import adminCoursesRouter from "./routes/adminCourses";
import adminLecturersRouter from "./routes/adminLecturers";
import adminLocationsRouter from "./routes/adminLocations";
import adminOrganizationRouter from "./routes/adminOrganization";
import adminSemestersRouter from "./routes/adminSemesters";
import adminStudentImportRouter from "./routes/adminStudentImport";
import adminStudentDevicesRouter from "./routes/adminStudentDevices";
import adminStudentsRouter from "./routes/adminStudents";
import adminSyncStatusRouter from "./routes/adminSyncStatus";
import authRouter from "./routes/auth";
import lecturerAttendanceReportsRouter from "./routes/lecturerAttendanceReports";
import lecturerAttendanceSessionsRouter from "./routes/lecturerAttendanceSessions";
import lecturerCatalogRouter from "./routes/lecturerCatalog";
import studentAttendanceHistoryRouter from "./routes/studentAttendanceHistory";
import studentAttendanceRouter from "./routes/studentAttendance";
import studentDeviceRouter from "./routes/studentDevice";
import studentRegistrationRouter from "./routes/studentRegistration";
import internalSyncRouter from "./routes/internalSync";

export const app = express();

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
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRouter);
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
app.use("/api/admin", adminAttendanceNetworksRouter);
app.use("/api/admin", adminAttendanceSessionsRouter);
app.use("/api/admin", adminAttendanceRecordsRouter);
app.use("/api/admin", adminAttendanceReportsRouter);
app.use("/api/admin", adminLocationsRouter);
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