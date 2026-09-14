import { Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import {
  completeDeviceEnrollment,
  startDeviceEnrollment,
} from "../services/studentDeviceEnrollmentService";
import { parseCompleteDeviceEnrollment } from "../validation/studentDeviceValidation";

const router = Router();

router.use(requireAuth, requireStudent);

// ------------------------------------------------------------------
// POST /api/student/device/enrollment/options
// Begin WebAuthn registration ceremony: returns challenge + RP info.
// The browser builds a PublicKeyCredentialCreationOptions payload from
// this data and hands it to navigator.credentials.create().
// ------------------------------------------------------------------
router.post("/device/enrollment/options", async (req, res) => {
  try {
    const result = await startDeviceEnrollment(req.user!.id);

    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          return res.status(404).json({
            error: "STUDENT_NOT_FOUND",
            message: "The authenticated user does not belong to a student profile.",
          });
        case "DEVICE_ALREADY_ENROLLED":
          return res.status(409).json({
            error: "DEVICE_ALREADY_ENROLLED",
            message: "A device is already enrolled for this student.",
          });
      }
    }

    res.status(200).json({ data: result.options });
  } catch (error) {
    console.error("Device enrollment options error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while creating device enrollment options.",
    });
  }
});

// ------------------------------------------------------------------
// POST /api/student/device/enrollment/complete
// Finalize enrollment: the client passes the credential output from
// navigator.credentials.create() plus an optional label.
// ------------------------------------------------------------------
router.post("/device/enrollment/complete", async (req, res) => {
  const input = parseCompleteDeviceEnrollment(req.body);
  if (!input) {
    return res.status(400).json({
      error: "INVALID_REQUEST",
      message:
        "Request body must include credential (with valid clientDataJSON and attestationObject) and an optional label.",
    });
  }

  try {
    const result = await completeDeviceEnrollment(
      req.user!.id,
      input.credential,
      input.label
    );

    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          return res.status(404).json({
            error: "STUDENT_NOT_FOUND",
            message: "The authenticated user does not belong to a student profile.",
          });
        case "DEVICE_ALREADY_ENROLLED":
          return res.status(409).json({
            error: "DEVICE_ALREADY_ENROLLED",
            message: "A device is already enrolled for this student.",
          });
        case "INVALID_CHALLENGE":
          return res.status(400).json({
            error: "INVALID_CHALLENGE",
            message:
              "The challenge is missing, expired, has already been consumed, or is not bound to this student.",
          });
        case "INVALID_CREDENTIAL":
          return res.status(400).json({
            error: "INVALID_CREDENTIAL",
            message:
              "The WebAuthn credential could not be verified. Please try again.",
          });
        case "CREDENTIAL_IN_USE":
          return res.status(409).json({
            error: "CREDENTIAL_IN_USE",
            message:
              "This device credential has already been enrolled by another student.",
          });
      }
    }

    res.status(201).json({
      credentialId: result.credentialId,
      device: result.device,
    });
  } catch (error) {
    console.error("Device enrollment complete error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while completing device enrollment.",
    });
  }
});

export default router;