import { Request, Response, Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import {
  getEligibleCourses,
  registerCourses,
} from "../services/studentCourseRegistrationStore";
import { parseRegistrationSelection } from "../validation/studentCourseRegistrationValidation";

const router = Router();

router.use(requireAuth, requireStudent);

router.get("/registration/courses", async (req: Request, res: Response) => {
  const result = await getEligibleCourses(req.user!.id);
  if (!result.ok) {
    res.status(404).json({
      error: "STUDENT_NOT_FOUND",
      message: "The student profile could not be found.",
    });
    return;
  }

  res.status(200).json({ data: result.data });
});

router.post("/registration/courses", async (req: Request, res: Response) => {
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
});

export default router;