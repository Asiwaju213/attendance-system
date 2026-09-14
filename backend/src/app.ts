import express, { NextFunction, Request, Response } from "express";
import { pool } from "./db/pool";
import adminCourseOfferingsRouter from "./routes/adminCourseOfferings";
import adminCoursesRouter from "./routes/adminCourses";
import adminOrganizationRouter from "./routes/adminOrganization";
import adminStudentImportRouter from "./routes/adminStudentImport";
import authRouter from "./routes/auth";
import studentDeviceRouter from "./routes/studentDevice";
import studentRegistrationRouter from "./routes/studentRegistration";

export const app = express();

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
app.use("/api/admin", adminOrganizationRouter);
app.use("/api/admin", adminCoursesRouter);
app.use("/api/admin", adminCourseOfferingsRouter);
app.use("/api/admin", adminStudentImportRouter);
app.use("/api/student", studentRegistrationRouter);
app.use("/api/student", studentDeviceRouter);

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