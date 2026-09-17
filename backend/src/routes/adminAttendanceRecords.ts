import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import { correctAttendanceRecord } from "../services/adminAttendanceRecordStore";
import {
  parseAttendanceRecordCorrection,
  parseIdParam,
} from "../validation/adminAttendanceRecordValidation";

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

router.patch("/attendance-records/:id", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    sendInvalidRequest(res, "A valid attendance record id is required.");
    return;
  }

  const input = parseAttendanceRecordCorrection(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "Request body must contain exactly one field: status, with value PRESENT or LATE."
    );
    return;
  }

  const result = await correctAttendanceRecord(req.user!.id, id, input.status);
  if (!result.ok) {
    switch (result.code) {
      case "RECORD_NOT_FOUND":
        res.status(404).json({
          error: "RECORD_NOT_FOUND",
          message: "The attendance record was not found.",
        });
        return;
      case "NO_OP_CORRECTION":
        res.status(409).json({
          error: "NO_OP_CORRECTION",
          message:
            "The attendance record already has this status; no correction was made.",
        });
        return;
    }
  }

  res.status(200).json({ data: result.data });
});

export default router;