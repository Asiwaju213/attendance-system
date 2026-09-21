import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  getStudentDeviceStatus,
  listAdminStudentDevices,
  resetStudentDevice,
} from "../services/adminStudentDeviceStore";
import {
  parseAdminDeviceListFilters,
  parseStudentIdParam,
} from "../validation/adminStudentDeviceValidation";

function firstQueryParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

const router = Router();

router.use(requireAuth, requireAdmin);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendForbidden(res: Response): void {
  res.status(403).json({
    error: "FORBIDDEN",
    message: "Only administrators may access student device administration.",
  });
}

function sendNotFound(res: Response, message: string): void {
  res.status(404).json({ error: "NOT_FOUND", message });
}

function sendConflict(res: Response, message: string): void {
  res.status(409).json({ error: "CONFLICT", message });
}

router.get("/student-devices", async (req: Request, res: Response) => {
  const filters = parseAdminDeviceListFilters(req.query);
  if (filters === null) {
    sendInvalidRequest(res, "Invalid filter parameters.");
    return;
  }

  try {
    const devices = await listAdminStudentDevices(filters);
    res.status(200).json({ data: devices });
  } catch (error) {
    console.error("Admin student devices list error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while listing student devices.",
    });
  }
});

router.get("/students/:studentId/device", async (req: Request, res: Response) => {
  const studentId = parseStudentIdParam(req.params.studentId);
  if (studentId === null) {
    sendInvalidRequest(res, "A valid student id is required.");
    return;
  }

  try {
    const status = await getStudentDeviceStatus(studentId);
    if (status === null) {
      sendNotFound(res, "The student was not found.");
      return;
    }

    res.status(200).json({ data: status });
  } catch (error) {
    console.error("Admin student device status error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while fetching the device status.",
    });
  }
});

router.post("/students/:studentId/device/reset", async (req: Request, res: Response) => {
  const studentId = parseStudentIdParam(req.params.studentId);
  if (studentId === null) {
    sendInvalidRequest(res, "A valid student id is required.");
    return;
  }

  try {
    const result = await resetStudentDevice(req.user!.id, studentId);

    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          return sendNotFound(res, "The student was not found.");
        case "NO_ACTIVE_DEVICE":
          return sendConflict(res, "The student does not have an active device to reset.");
        case "CONFLICT":
          return sendConflict(res, "The device could not be reset due to a concurrent change.");
      }
    }

    res.status(200).json({ data: result });
  } catch (error) {
    console.error("Admin student device reset error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while resetting the student device.",
    });
  }
});

export default router;