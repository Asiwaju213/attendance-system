import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { getCourseOfferingAttendanceReport } from "../services/attendanceReportStore";
import { parseIdParam } from "../validation/adminAttendanceReportValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

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

    const report = await getCourseOfferingAttendanceReport(courseOfferingId);
    if (report === null) {
      res.status(404).json({
        error: "OFFERING_NOT_FOUND",
        message: "The course offering was not found.",
      });
      return;
    }

    res.status(200).json({ data: report });
  }
);

export default router;