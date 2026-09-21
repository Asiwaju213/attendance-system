import { Request, Response, Router } from "express";
import { requireAuth, requireLecturer } from "../middleware/authenticate";
import {
  getLecturerCourseOfferingReport,
  getLecturerSessionAttendanceReport,
} from "../services/lecturerAttendanceReportStore";
import { parseIdParam } from "../validation/lecturerAttendanceSessionValidation";

const router = Router();

router.use(requireAuth, requireLecturer);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

router.get(
  "/attendance-reports/course-offering/:courseOfferingId",
  async (req: Request, res: Response) => {
    const courseOfferingId = parseIdParam(req.params.courseOfferingId);
    if (courseOfferingId === null) {
      sendInvalidRequest(res, "A valid course offering id is required.");
      return;
    }

    // The report is always scoped to the authenticated lecturer; ids from the
    // client are never trusted for authorization.
    const result = await getLecturerCourseOfferingReport(
      req.user!.id,
      courseOfferingId
    );
    if (!result.ok) {
      if (result.code === "LECTURER_NOT_FOUND") {
        res.status(404).json({
          error: "LECTURER_NOT_FOUND",
          message: "The lecturer profile could not be found.",
        });
        return;
      }
      // Unassigned, inactive, not-open, or missing offerings are all reported
      // identically so their existence cannot be probed.
      res.status(404).json({
        error: "OFFERING_NOT_FOUND",
        message: "The course offering was not found.",
      });
      return;
    }

    res.status(200).json({ data: result.data });
  }
);

router.get(
  "/attendance-reports/session/:attendanceSessionId",
  async (req: Request, res: Response) => {
    const attendanceSessionId = parseIdParam(req.params.attendanceSessionId);
    if (attendanceSessionId === null) {
      sendInvalidRequest(res, "A valid attendance session id is required.");
      return;
    }

    const result = await getLecturerSessionAttendanceReport(
      req.user!.id,
      attendanceSessionId
    );
    if (!result.ok) {
      if (result.code === "LECTURER_NOT_FOUND") {
        res.status(404).json({
          error: "LECTURER_NOT_FOUND",
          message: "The lecturer profile could not be found.",
        });
        return;
      }
      // Unassigned, inactive, non-ended, or missing sessions are all reported
      // identically so their existence cannot be probed.
      res.status(404).json({
        error: "SESSION_NOT_FOUND",
        message: "The attendance session was not found.",
      });
      return;
    }

    res.status(200).json({ data: result.data });
  }
);

export default router;