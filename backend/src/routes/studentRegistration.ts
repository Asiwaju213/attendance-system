import { Request, Response, Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import {
  getEligibleCourses,
  getMyCourseRegistrations,
  registerCourses,
} from "../services/studentCourseRegistrationStore";
import { parseRegistrationSelection } from "../validation/studentCourseRegistrationValidation";

const router = Router();

// This router is mounted at `/api/student` alongside the device, attendance and course
// routers, and it is mounted FIRST. A router-level `router.use(requireAuth, ...)` would therefore
// run for every `/api/student/*` request and reject anything without a session before the later
// routers are ever consulted — which silently makes the grant-based first-device enrollment flow
// (which deliberately has no session yet) unreachable. So the guard is attached to this router's
// own routes instead of to the router as a whole.
const studentOnly = [requireAuth, requireStudent];

router.get(
  "/registration/courses",
  studentOnly,
  async (req: Request, res: Response) => {
    const result = await getEligibleCourses(req.user!.id);
    if (!result.ok) {
      res.status(404).json({
        error: "STUDENT_NOT_FOUND",
        message: "The student profile could not be found.",
      });
      return;
    }

    res.status(200).json({ data: result.data });
  }
);

// GET /api/student/course-registrations
// The authenticated student's own ENROLLED courses for the active academic
// session. The student identity comes from req.user.id only — never from
// client-supplied parameters.
router.get(
  "/course-registrations",
  studentOnly,
  async (req: Request, res: Response) => {
    const result = await getMyCourseRegistrations(req.user!.id);
    if (!result.ok) {
      res.status(404).json({
        error: "STUDENT_NOT_FOUND",
        message: "The student profile could not be found.",
      });
      return;
    }

    res.status(200).json({ data: result.data });
  }
);

router.post(
  "/registration/courses",
  studentOnly,
  async (req: Request, res: Response) => {
    const input = parseRegistrationSelection(req.body);
    if (!input) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "A non-empty array of unique offeringIds is required.",
      });
      return;
    }

  const result = await registerCourses(req.user!.id, input.offeringIds);
    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          res.status(404).json({
            error: "STUDENT_NOT_FOUND",
            message: "The student profile could not be found.",
          });
          return;
        case "NO_ACTIVE_ACADEMIC_SESSION":
          res.status(409).json({
            error: "NO_ACTIVE_ACADEMIC_SESSION",
            message: "Course registration is not currently open.",
          });
          return;
        case "INVALID_COURSE_SELECTION":
          res.status(409).json({
            error: "INVALID_COURSE_SELECTION",
            message: "One or more selected courses are not available for registration.",
          });
          return;
      }
    }

    const status = result.data.registered.length > 0 ? 201 : 200;
    res.status(status).json({ data: result.data });
  }
);

export default router;