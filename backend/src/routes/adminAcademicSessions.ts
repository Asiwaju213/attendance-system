import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  AcademicSessionWriteResult,
  createAcademicSession,
  listAcademicSessions,
  updateAcademicSession,
} from "../services/academicSessionStore";
import {
  parseCreateAcademicSession,
  parseIdParam,
  parseUpdateAcademicSession,
} from "../validation/adminAcademicSessionValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<AcademicSessionWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "ACADEMIC_SESSION_NOT_FOUND":
      res
        .status(404)
        .json({ error: "ACADEMIC_SESSION_NOT_FOUND", message: "The academic session does not exist." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({
          error: "CONFLICT",
          message: "An academic session with this name already exists.",
        });
      return;
  }
}

router.get("/academic-sessions", async (_req: Request, res: Response) => {
  const sessions = await listAcademicSessions();
  res.status(200).json({ data: sessions });
});

router.post("/academic-sessions", async (req: Request, res: Response) => {
  const input = parseCreateAcademicSession(req.body);
  if (!input) {
    sendInvalidRequest(res, "A valid academic session name is required.");
    return;
  }

  const result = await createAcademicSession(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.setHeader("Location", `/api/admin/academic-sessions/${result.data.id}`);
  res.status(201).json({ data: result.data });
});

router.patch("/academic-sessions/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid academic session id is required.");
    return;
  }

  const input = parseUpdateAcademicSession(req.body);
  if (!input) {
    sendInvalidRequest(res, "Provide at least one valid field: name or isActive.");
    return;
  }

  const result = await updateAcademicSession(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;