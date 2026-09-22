import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  getStudentDeviceStatus,
  listAdminStudentDevices,
  resetStudentDevice,
  type AdminStudentDeviceRow,
  type AdminStudentDeviceSummary,
} from "../services/adminStudentDeviceStore";
import {
  parseAdminDeviceListFilters,
  parseStudentIdParam,
} from "../validation/adminStudentDeviceValidation";

const router = Router();

// Serialize the snake_case storage row into the camelCase JSON shape the admin
// UI consumes. No key material or raw challenges are present on these rows.
function serializeDevice(device: AdminStudentDeviceRow) {
  return {
    id: device.id,
    studentId: device.student_id,
    credentialId: device.credential_id,
    credType: device.cred_type,
    aaguid: device.aaguid,
    label: device.label,
    transports: device.transports,
    status: device.status,
    enrolledAt: device.enrolled_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    counter: device.counter,
  };
}

function serializeSummary(summary: AdminStudentDeviceSummary) {
  return {
    studentId: summary.studentId,
    studentName: summary.studentName,
    matricNumber: summary.matricNumber,
    device: summary.device ? serializeDevice(summary.device) : null,
    hasActiveDevice: summary.hasActiveDevice,
  };
}

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
    res.status(200).json({ data: devices.map(serializeSummary) });
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

    res.status(200).json({ data: serializeSummary(status) });
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

    res.status(200).json({
      data: {
        ok: true,
        device: result.device ? serializeDevice(result.device) : null,
        previousStatus: result.previousStatus,
      },
    });
  } catch (error) {
    console.error("Admin student device reset error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while resetting the student device.",
    });
  }
});

export default router;