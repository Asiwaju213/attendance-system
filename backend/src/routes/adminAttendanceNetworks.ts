import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  AttendanceNetworkWriteResult,
  createAttendanceNetwork,
  listAttendanceNetworks,
  updateAttendanceNetwork,
} from "../services/attendanceNetworkStore";
import {
  parseAttendanceNetworkListFilters,
  parseCreateAttendanceNetwork,
  parseIdParam,
  parseUpdateAttendanceNetwork,
} from "../validation/adminAttendanceNetworkValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendWriteError(
  res: Response,
  result: Extract<AttendanceNetworkWriteResult<unknown>, { ok: false }>
): void {
  switch (result.code) {
    case "NOT_FOUND":
      res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Attendance network not found." });
      return;
    case "CONFLICT":
      res
        .status(409)
        .json({
          error: "CONFLICT",
          message: "An attendance network with this code already exists.",
        });
      return;
  }
}

router.get("/attendance-networks", async (req: Request, res: Response) => {
  const filters = parseAttendanceNetworkListFilters(req.query);
  if (!filters) {
    sendInvalidRequest(res, "Invalid filter. Use status.");
    return;
  }

  const networks = await listAttendanceNetworks(filters);
  res.status(200).json({ data: networks });
});

router.post("/attendance-networks", async (req: Request, res: Response) => {
  const input = parseCreateAttendanceNetwork(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "A valid networkCode and name are required."
    );
    return;
  }

  const result = await createAttendanceNetwork(input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.patch("/attendance-networks/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid attendance network id is required.");
    return;
  }

  const input = parseUpdateAttendanceNetwork(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Provide at least one valid field: name or status."
    );
    return;
  }

  const result = await updateAttendanceNetwork(id, input);
  if (!result.ok) {
    sendWriteError(res, result);
    return;
  }

  res.status(200).json({ data: result.data });
});

export default router;