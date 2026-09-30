import { Router } from "express";
import { requireAuth, requireStudent } from "../middleware/authenticate";
import { authConfig, clearDeviceBindingCookieOptions } from "../config/auth";
import {
  completeDeviceEnrollment,
  getStudentDeviceStatus,
  startDeviceEnrollment,
} from "../services/studentDeviceEnrollmentService";
import { parseCompleteDeviceEnrollment } from "../validation/studentDeviceValidation";

const router = Router();

router.use(requireAuth, requireStudent);

// ------------------------------------------------------------------
// GET /api/student/device
// Read-only report of the student's current device state, so the UI can
// render the right state without starting a ceremony.
//
// This endpoint is intentionally side-effect free: it creates, consumes and
// expires no challenge, writes no device row, and does not touch the
// attendance challenge. In particular it must never be implemented in terms
// of the enrollment-options endpoint below, which issues a challenge and
// expires the student's existing one.
// ------------------------------------------------------------------
router.get("/device", async (req, res) => {
  try {
    const result = await getStudentDeviceStatus(req.user!.id);

    if (!result.ok) {
      return res.status(404).json({
        error: "STUDENT_NOT_FOUND",
        message: "The authenticated user does not belong to a student profile.",
      });
    }

    res.status(200).json({
      enrollmentMode: result.state,
      // Reported as stored: null means "unknown", which is every device enrolled before the
      // discoverability column existed. It is treated as needing an upgrade, exactly like the
      // login gate treats it.
      discoverable: result.discoverable,
      // No credential id, public key, counter or AAGUID is exposed: the student UI needs none
      // of them, and they are credential internals.
      device: result.device
        ? { enrolledAt: result.device.enrolledAt, label: result.device.label }
        : null,
    });
  } catch (error) {
    console.error("Device status error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while fetching the device status.",
    });
  }
});

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

    // `enrollmentMode` is additive: existing clients that ignore it are unaffected. It tells the
    // caller whether this is a first enrollment or an authenticated upgrade of a legacy
    // non-discoverable credential, so the UI can label the ceremony accurately.
    res
      .status(200)
      .json({ data: result.options, enrollmentMode: result.mode });
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

    // Set the device-binding cookie so this device is bound to this student
    // for password-only returning login. The cookie stores the credential ID
    // and is HTTP-only, Secure, SameSite=Lax with a 90-day lifetime.
    res.cookie(
      authConfig.deviceBindingCookieName,
      result.credentialId,
      authConfig.deviceBindingCookie
    );

    res.status(201).json({
      credentialId: result.credentialId,
      // Present only for an upgrade, and always null otherwise. The old credential row is
      // REVOKED, not deleted.
      replacedCredentialId: result.replacedCredentialId,
      // False means the authenticator ignored `residentKey: "required"`. The credential is
      // still usable for attendance; the student can run the upgrade again.
      discoverable: result.discoverable,
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