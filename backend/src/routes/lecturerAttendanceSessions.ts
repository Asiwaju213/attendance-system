import { Request, Response, Router } from "express";
import { requireAuth, requireLecturer } from "../middleware/authenticate";
import {
  CreateSessionErrorCode,
  createAttendanceSession,
  endSession,
  listLecturerSessions,
} from "../services/attendanceSessionStore";
import {
  parseCreateAttendanceSession,
  parseIdParam,
} from "../validation/lecturerAttendanceSessionValidation";

const router = Router();

router.use(requireAuth, requireLecturer);

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function sendCreateError(res: Response, code: CreateSessionErrorCode): void {
  switch (code) {
    case "LECTURER_NOT_FOUND":
      res
        .status(404)
        .json({
          error: "LECTURER_NOT_FOUND",
          message: "The lecturer profile could not be found.",
        });
      return;
    case "OFFERING_NOT_FOUND":
      res
        .status(404)
        .json({
          error: "OFFERING_NOT_FOUND",
          message: "The course offering does not exist.",
        });
      return;
    case "OFFERING_NOT_OPEN":
      res
        .status(409)
        .json({
          error: "OFFERING_NOT_OPEN",
          message: "The course offering is not open for attendance.",
        });
      return;
    case "COURSE_NOT_ACTIVE":
      res
        .status(409)
        .json({
          error: "COURSE_NOT_ACTIVE",
          message: "The course is not active.",
        });
      return;
    case "LECTURER_NOT_ASSIGNED":
      res
        .status(409)
        .json({
          error: "LECTURER_NOT_ASSIGNED",
          message: "You are not assigned to this course offering.",
        });
      return;
    case "ATTENDANCE_NETWORK_NOT_FOUND":
      res
        .status(404)
        .json({
          error: "ATTENDANCE_NETWORK_NOT_FOUND",
          message: "The attendance network does not exist.",
        });
      return;
    case "ATTENDANCE_NETWORK_INACTIVE":
      res
        .status(409)
        .json({
          error: "ATTENDANCE_NETWORK_INACTIVE",
          message: "The attendance network is not active.",
        });
      return;
    case "LOCATION_NOT_FOUND":
      res
        .status(404)
        .json({
          error: "LOCATION_NOT_FOUND",
          message: "The location does not exist.",
        });
      return;
    case "LOCATION_INACTIVE":
      res
        .status(409)
        .json({
          error: "LOCATION_INACTIVE",
          message: "The location is not active.",
        });
      return;
    case "ACTIVE_SESSION_EXISTS":
      res
        .status(409)
        .json({
          error: "ACTIVE_SESSION_EXISTS",
          message: "You already have a running attendance session.",
        });
      return;
  }
}

router.post("/attendance-sessions", async (req: Request, res: Response) => {
  const input = parseCreateAttendanceSession(req.body);
  if (!input) {
    sendInvalidRequest(
      res,
      "A valid courseOfferingId, attendanceNetworkId, locationId, durationMinutes (1-480), and lateThresholdMinutes (0-120, no greater than durationMinutes) are required."
    );
    return;
  }

  const result = await createAttendanceSession(req.user!.id, input);
  if (!result.ok) {
    sendCreateError(res, result.code);
    return;
  }

  res.status(201).json({ data: result.data });
});

router.get("/attendance-sessions", async (req: Request, res: Response) => {
  const result = await listLecturerSessions(req.user!.id);
  if (!result.ok) {
    res
      .status(404)
      .json({
        error: "LECTURER_NOT_FOUND",
        message: "The lecturer profile could not be found.",
      });
    return;
  }

  res.status(200).json({ data: result.data });
});

router.post("/attendance-sessions/:id/end", async (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id);
  if (!id) {
    sendInvalidRequest(res, "A valid attendance session id is required.");
    return;
  }

  const result = await endSession(req.user!.id, id);
  if (!result.ok) {
    switch (result.code) {
      case "SESSION_NOT_FOUND":
        res
          .status(404)
          .json({
            error: "SESSION_NOT_FOUND",
            message: "The attendance session was not found.",
          });
        return;
      case "SESSION_ALREADY_ENDED":
        res
          .status(409)
          .json({
            error: "SESSION_ALREADY_ENDED",
            message: "This attendance session has already ended.",
          });
        return;
      case "SESSION_EXPIRED":
        res
          .status(409)
          .json({
            error: "SESSION_EXPIRED",
            message: "This attendance session has expired and can no longer be ended manually.",
          });
        return;
    }
  }

  res.status(200).json({ data: result.data });
});

export default router;