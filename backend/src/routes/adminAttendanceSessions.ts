import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  getAdminSessionById,
  listAdminAttendanceRecords,
  listAdminSessions,
} from "../services/attendanceSessionStore";
import {
  parseAdminAttendanceSessionListFilters,
  parseIdParam,
} from "../validation/adminAttendanceSessionValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

router.get("/attendance-sessions", async (req: Request, res: Response) => {
  const filters = parseAdminAttendanceSessionListFilters(req.query);
  if (filters === null) {
    sendInvalidRequest(
      res,
      "Invalid query parameters. IDs must be positive integers. Status must be ACTIVE or ENDED. from/to must be valid ISO timestamps with from <= to."
    );
    return;
  }

  const sessions = await listAdminSessions(filters);
  res.status(200).json({ data: sessions });
});

router.get("/attendance-sessions/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    sendInvalidRequest(res, "A valid attendance session id is required.");
    return;
  }

  const session = await getAdminSessionById(id);
  if (session === null) {
    res.status(404).json({
      error: "SESSION_NOT_FOUND",
      message: "The attendance session was not found.",
    });
    return;
  }

  res.status(200).json({ data: session });
});

router.get("/attendance-sessions/:id/records", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    sendInvalidRequest(res, "A valid attendance session id is required.");
    return;
  }

  const session = await getAdminSessionById(id);
  if (session === null) {
    res.status(404).json({
      error: "SESSION_NOT_FOUND",
      message: "The attendance session was not found.",
    });
    return;
  }

  const records = await listAdminAttendanceRecords(id);
  res.status(200).json({ data: records });
});

export default router;
