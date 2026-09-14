import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  createSemester,
  listSemesters,
  SemesterWriteResult,
  updateSemester,
} from "../services/semesterStore";
import {
  parseCreateSemester,
  parseIdParam,
  parseUpdateSemester,
} from "../validation/adminSemesterValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<SemesterWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "SEMESTER_NOT_FOUND":
      res
        .status(404)
        .json({ error: "SEMESTER_NOT_FOUND", message: "The semester does not exist." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({ error: "CONFLICT", message: "A semester with this name already exists." });
      return;
  }
}

router.get("/semesters", async (_req: Request, res: Response) => {
  const semesters = await listSemesters();
  res.status(200).json({ data: semesters });
});

router.post("/semesters", async (req: Request, res: Response) => {
  const input = parseCreateSemester(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide a valid semester name (First Semester or Second Semester)."
    );
    return;
  }

  const result = await createSemester(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.setHeader("Location", `/api/admin/semesters/${result.data.id}`);
  res.status(201).json({ data: result.data });
});

router.patch("/semesters/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid semester id is required.");
    return;
  }

  const input = parseUpdateSemester(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide a valid semester name (First Semester or Second Semester)."
    );
    return;
  }

  const result = await updateSemester(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;