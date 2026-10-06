import { Request, Response, Router } from "express";
import { appendFileSync } from "node:fs";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  getAdminStudentDetail,
  listAdminStudents,
  resetStudentRegistration,
  updateStudentStatus,
} from "../services/adminStudentStore";
import {
  parseAdminStudentListFilters,
  parseIdParam,
  parseUpdateStudentStatus,
} from "../validation/adminStudentValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendNotFound(res: Response, message: string): void {
  res.status(404).json({ error: "NOT_FOUND", message });
}

function sendConflict(res: Response, error: string, message: string): void {
  res.status(409).json({ error, message });
}

router.get("/students", async (req: Request, res: Response) => {
  const filters = parseAdminStudentListFilters(req.query);
  if (filters === null) {
    sendInvalidRequest(res, "Invalid filter parameters.");
    return;
  }

  try {
    const data = await listAdminStudents(filters);
    res.status(200).json({ data });
  } catch (error) {
    console.error("Admin students list error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while listing students.",
    });
  }
});

router.get("/students/:studentId", async (req: Request, res: Response) => {
  const studentId = parseIdParam(req.params.studentId);
  if (studentId === null) {
    sendInvalidRequest(res, "A valid student id is required.");
    return;
  }

  try {
    const detail = await getAdminStudentDetail(studentId);
    if (detail === null) {
      sendNotFound(res, "The student was not found.");
      return;
    }

    res.status(200).json({ data: detail });
  } catch (error) {
    console.error("Admin students detail error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while fetching the student.",
    });
  }
});

router.patch("/students/:studentId/status", async (req: Request, res: Response) => {
  const studentId = parseIdParam(req.params.studentId);
  if (studentId === null) {
    sendInvalidRequest(res, "A valid student id is required.");
    return;
  }

  const input = parseUpdateStudentStatus(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Request body must contain exactly one field: status, with value ACTIVE or INACTIVE."
    );
    return;
  }

  try {
    const result = await updateStudentStatus(req.user!.id, studentId, input.status);
    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          sendNotFound(res, "The student was not found.");
          return;
        case "NO_OP_CORRECTION":
          sendConflict(
            res,
            "NO_OP_CORRECTION",
            "The student already has this status; no change was made."
          );
          return;
        case "ACTIVE_REQUIRES_PASSWORD":
          sendConflict(
            res,
            "ACTIVE_REQUIRES_PASSWORD",
            "The account has no password and cannot be activated."
          );
          return;
      }
    }

    res.status(200).json({ data: result.data });
  } catch (error) {
    console.error("Admin students status error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while updating the student status.",
    });
  }
});

router.post(
  "/students/:studentId/reset-registration",
  async (req: Request, res: Response) => {
    const studentId = parseIdParam(req.params.studentId);
    if (studentId === null) {
      sendInvalidRequest(res, "A valid student id is required.");
      return;
    }

    try {
      const result = await resetStudentRegistration(req.user!.id, studentId);
      if (!result.ok) {
        switch (result.code) {
          case "STUDENT_NOT_FOUND":
            sendNotFound(res, "The student was not found.");
            return;
          case "ALREADY_PENDING":
            sendConflict(
              res,
              "ALREADY_PENDING",
              "The student is already pending registration."
            );
            return;
          case "INVALID_STUDENT_STATE":
            sendConflict(
              res,
              "INVALID_STUDENT_STATE",
              "Only active students may be reset for re-registration."
            );
            return;
        }
      }

      res.status(200).json({ data: result.data });
    } catch (error) {
      const err = error as Error & {
        code?: unknown;
        constraint?: unknown;
        detail?: unknown;
        table?: unknown;
      };
      const summary = JSON.stringify({
        name: err.name,
        message: err.message,
        code: err.code ?? null,
        constraint: err.constraint ?? null,
        detail: err.detail ?? null,
        table: err.table ?? null,
      });
      console.error("Admin students reset error.", summary, err.stack ?? "(no stack)");
      // TEMP-DIAGNOSTIC: persist the underlying error so it can be inspected;
      // removed once the root cause is captured.
      try {
        appendFileSync(
          process.cwd() + "/reset-error.debug.log",
          `${new Date().toISOString()} ${summary} stack=${err.stack ?? "(no stack)"}\n`
        );
      } catch {
        // Diagnostics logging must never break the response path.
      }
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "An unexpected error occurred while resetting the student registration.",
      });
    }
  }
);

export default router;