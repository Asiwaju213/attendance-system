import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { CourseWriteResult } from "../services/courseStore";
import {
  createCourse,
  listCourses,
  updateCourse,
} from "../services/courseStore";
import {
  parseCourseListFilters,
  parseCreateCourse,
  parseIdParam,
  parseUpdateCourse,
} from "../validation/adminCourseValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<CourseWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "NOT_FOUND":
      res.status(404).json({ error: "NOT_FOUND", message: "Course not found." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({ error: "CONFLICT", message: "A course with this code already exists." });
      return;
    case "FACULTY_NOT_FOUND":
      res
        .status(404)
        .json({ error: "FACULTY_NOT_FOUND", message: "The faculty does not exist." });
      return;
    case "DEPARTMENT_NOT_FOUND":
      res
        .status(404)
        .json({
          error: "DEPARTMENT_NOT_FOUND",
          message: "The department does not exist.",
        });
      return;
    case "LEVEL_NOT_FOUND":
      res
        .status(404)
        .json({ error: "LEVEL_NOT_FOUND", message: "The level does not exist." });
      return;
  }
}

router.get("/courses", async (req: Request, res: Response) => {
  const filters = parseCourseListFilters(req.query);
  if (!filters) {
    sendInvalidRequest(
      res,
      "Invalid filter. Use facultyId, departmentId, levelId, or status."
    );
    return;
  }

  const courses = await listCourses(filters);
  res.status(200).json({ data: courses });
});

router.post("/courses", async (req: Request, res: Response) => {
  const input = parseCreateCourse(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "A valid courseCode, title, levelId, and exactly one of facultyId or departmentId are required."
    );
    return;
  }

  const result = await createCourse(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/courses/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid course id is required.");
    return;
  }

  const input = parseUpdateCourse(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: courseCode, title, levelId, facultyId, departmentId, or status."
    );
    return;
  }

  const result = await updateCourse(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;