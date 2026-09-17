import { Request, Response, Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import {
  createAttendanceDeviceChallenge,
  markAttendanceWithDeviceProof,
} from "../services/studentAttendanceDeviceService";
import { getEligibleAttendanceSessions } from "../services/studentAttendanceStore";
import { parseMarkAttendance } from "../validation/studentAttendanceValidation";

const router = Router();

router.use(requireAuth, requireStudent);

router.get("/attendance/eligible", async (req: Request, res: Response) => {
  const result = await getEligibleAttendanceSessions(req.user!.id);
  if (!result.ok) {
    res.status(404).json({
      error: "STUDENT_NOT_FOUND",
      message: "The student profile could not be found.",
    });
    return;
  }

  res.status(200).json({ data: result.data });
});

// ------------------------------------------------------------------
// POST /api/student/attendance/device-challenge
// Issue a short-lived, single-use assertion challenge bound to the
// authenticated student's sole ACTIVE enrolled device.
// ------------------------------------------------------------------
router.post("/attendance/device-challenge", async (req: Request, res: Response) => {
  try {
    const result = await createAttendanceDeviceChallenge(req.user!.id);

    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          res.status(404).json({
            error: "STUDENT_NOT_FOUND",
            message: "The student profile could not be found.",
          });
          return;
        case "NO_ENROLLED_DEVICE":
          res.status(409).json({
            error: "NO_ENROLLED_DEVICE",
            message: "No device has been enrolled for this student.",
          });
          return;
        case "DEVICE_NOT_ACTIVE":
          res.status(409).json({
            error: "DEVICE_NOT_ACTIVE",
            message:
              "The enrolled device is not active. Please re-enroll your device.",
          });
          return;
      }
    }

    res.status(200).json({ data: result.data });
  } catch (error) {
    console.error(
      "Attendance device challenge error.",
      (error as Error).message
    );
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while creating the device challenge.",
    });
  }
});

function sendMarkError(res: Response, code: string): void {
  switch (code) {
    case "STUDENT_NOT_FOUND":
      res.status(404).json({
        error: "STUDENT_NOT_FOUND",
        message: "The student profile could not be found.",
      });
      return;
    case "SESSION_NOT_FOUND":
      res.status(404).json({
        error: "SESSION_NOT_FOUND",
        message: "The attendance session does not exist.",
      });
      return;
    case "SESSION_NOT_ACTIVE":
      res.status(409).json({
        error: "SESSION_NOT_ACTIVE",
        message: "This attendance session is not currently active.",
      });
      return;
    case "OFFERING_NOT_OPEN":
      res.status(409).json({
        error: "OFFERING_NOT_OPEN",
        message: "The course offering is not open for attendance.",
      });
      return;
    case "COURSE_NOT_ACTIVE":
      res.status(409).json({
        error: "COURSE_NOT_ACTIVE",
        message: "The course is not active.",
      });
      return;
    case "STUDENT_NOT_REGISTERED":
      res.status(409).json({
        error: "STUDENT_NOT_REGISTERED",
        message: "You are not registered for this course offering.",
      });
      return;
    case "ALREADY_MARKED":
      res.status(409).json({
        error: "ALREADY_MARKED",
        message: "Attendance has already been marked for this session.",
      });
      return;
    case "NO_ENROLLED_DEVICE":
      res.status(409).json({
        error: "NO_ENROLLED_DEVICE",
        message: "No device has been enrolled for this student.",
      });
      return;
    case "DEVICE_NOT_ACTIVE":
      res.status(409).json({
        error: "DEVICE_NOT_ACTIVE",
        message:
          "The enrolled device is not active. Please re-enroll your device.",
      });
      return;
    case "INVALID_CHALLENGE":
      res.status(400).json({
        error: "INVALID_CHALLENGE",
        message:
          "The device challenge is invalid, does not belong to this student, or could not be found.",
      });
      return;
    case "CHALLENGE_EXPIRED":
      res.status(400).json({
        error: "CHALLENGE_EXPIRED",
        message:
          "The device challenge has expired. Please request a new challenge.",
      });
      return;
    case "CHALLENGE_ALREADY_USED":
      res.status(400).json({
        error: "CHALLENGE_ALREADY_USED",
        message:
          "The device challenge has already been used. Please request a new challenge.",
      });
      return;
    case "INVALID_DEVICE_ASSERTION":
      res.status(400).json({
        error: "INVALID_DEVICE_ASSERTION",
        message:
          "The device assertion could not be verified. Please try again.",
      });
      return;
  }
}

// ------------------------------------------------------------------
// POST /api/student/attendance
// Mark attendance for a session.  Requires a valid device proof
// (challenge + signed assertion) submitted via device-challenge first.
// ------------------------------------------------------------------
router.post("/attendance", async (req: Request, res: Response) => {
  const input = parseMarkAttendance(req.body);
  if (!input) {
    res.status(400).json({
      error: "INVALID_REQUEST",
      message:
        "Request must include a valid attendanceSessionId and an assertion object.",
    });
    return;
  }

  const result = await markAttendanceWithDeviceProof(
    req.user!.id,
    input.attendanceSessionId,
    input.challenge,
    input.assertion
  );
  if (!result.ok) {
    sendMarkError(res, result.code);
    return;
  }

  res.status(201).json({ data: result.data });
});

export default router;
