import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  assignLecturer,
  createOffering,
  listAssignedLecturers,
  listOfferings,
  OfferingErrorCode,
  OfferingMutationResult,
  OfferingWriteResult,
  removeLecturer,
  updateOffering,
} from "../services/courseOfferingStore";
import {
  parseAssignLecturer,
  parseCreateOffering,
  parseIdParam,
  parseOfferingListFilters,
  parseUpdateOffering,
} from "../validation/adminCourseOfferingValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendErrorCode(res: Response, code: OfferingErrorCode): void {
  switch (code) {
    case "NOT_FOUND":
      res.status(404).json({ error: "NOT_FOUND", message: "Course offering not found." });
      return;
    case "COURSE_NOT_FOUND":
      res.status(404).json({ error: "COURSE_NOT_FOUND", message: "The course does not exist." });
      return;
    case "ACADEMIC_SESSION_NOT_FOUND":
      res
        .status(404)
        .json({ error: "ACADEMIC_SESSION_NOT_FOUND", message: "The academic session does not exist." });
      return;
    case "SEMESTER_NOT_FOUND":
      res.status(404).json({ error: "SEMESTER_NOT_FOUND", message: "The semester does not exist." });
      return;
    case "LECTURER_NOT_FOUND":
      res.status(404).json({ error: "LECTURER_NOT_FOUND", message: "The lecturer does not exist." });
      return;
    case "NOT_ASSIGNED":
      res
        .status(404)
        .json({ error: "NOT_ASSIGNED", message: "The lecturer is not assigned to this offering." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({
          error: "CONFLICT",
          message: "An offering for this course, academic session, and semester already exists.",
        });
      return;
    case "COURSE_NOT_ACTIVE":
      res
        .status(409)
        .json({ error: "COURSE_NOT_ACTIVE", message: "An inactive course cannot receive a new offering." });
      return;
    case "LECTURER_NOT_ACTIVE":
      res
        .status(409)
        .json({ error: "LECTURER_NOT_ACTIVE", message: "An inactive lecturer cannot be assigned." });
      return;
    case "ALREADY_ASSIGNED":
      res
        .status(409)
        .json({ error: "ALREADY_ASSIGNED", message: "This lecturer is already assigned to the offering." });
      return;
    case "HAS_REGISTRATIONS":
      res
        .status(409)
        .json({
          error: "HAS_REGISTRATIONS",
          message: "The offering has student registrations and its academic details cannot be changed.",
        });
      return;
    case "HAS_ATTENDANCE":
      res
        .status(409)
        .json({
          error: "HAS_ATTENDANCE",
          message: "The offering has attendance records and its academic details cannot be changed.",
        });
      return;
    case "NOT_A_LECTURER":
      res
        .status(400)
        .json({ error: "NOT_A_LECTURER", message: "The referenced user is not a lecturer." });
      return;
  }
}

router.get("/course-offerings", async (req: Request, res: Response) => {
  const filters = parseOfferingListFilters(req.query);
  if (!filters) {
    sendInvalidRequest(
      res,
      "Invalid filter. Use courseId, academicSessionId, semesterId, status, facultyId, departmentId, or levelId."
    );
    return;
  }

  const offerings = await listOfferings(filters);
  res.status(200).json({ data: offerings });
});

router.post("/course-offerings", async (req: Request, res: Response) => {
  const input = parseCreateOffering(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "A valid courseId, academicSessionId, and semesterId are required."
    );
    return;
  }

  const result = await createOffering(input);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/course-offerings/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid offering id is required.");
    return;
  }

  const input = parseUpdateOffering(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: courseId, academicSessionId, semesterId, or status."
    );
    return;
  }

  const result = await updateOffering(id, input);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(200).json({ data: result.data });
});

router.get("/course-offerings/:id/lecturers", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid offering id is required.");
    return;
  }

  const result = await listAssignedLecturers(id);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(200).json({ data: result.data });
});

router.post("/course-offerings/:id/lecturers", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid offering id is required.");
    return;
  }

  const input = parseAssignLecturer(req.body);
  if (!input) {
    sendInvalidRequest(res, "A valid lecturerId is required.");
    return;
  }

  const result = await assignLecturer(id, input);
  if (!result.ok) {
    sendErrorCode(res, result.code);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.delete(
  "/course-offerings/:id/lecturers/:lecturerId",
  async (req: Request, res: Response) => {
    const id = parseIdParam(req.params.id);
    if (!id) {
      sendInvalidRequest(res, "A valid offering id is required.");
      return;
    }
    const lecturerId = parseIdParam(req.params.lecturerId);
    if (!lecturerId) {
      sendInvalidRequest(res, "A valid lecturer id is required.");
      return;
    }

    const result: OfferingMutationResult = await removeLecturer(id, lecturerId);
    if (!result.ok) {
      sendErrorCode(res, result.code);
      return;
    }

    res.status(204).end();
  }
);

export default router;