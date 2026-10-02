import { Request, Response, Router } from "express";
import {
  resolveEnrollmentAuth,
  type EnrollmentAuthContext,
} from "../middleware/enrollmentGrantAuth";
import { loadSessionIfPresent } from "../middleware/authenticate";
import {
  authConfig,
  clearEnrollmentGrantCookieOptions,
} from "../config/auth";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";
import {
  completeDeviceEnrollment,
  getStudentDeviceStatus,
  startDeviceEnrollment,
} from "../services/studentDeviceEnrollmentService";
import { consumeEnrollmentGrant } from "../services/studentDeviceEnrollmentGrantStore";
import { createSession } from "../services/sessionStore";
import { parseCompleteDeviceEnrollment } from "../validation/studentDeviceValidation";

const router = Router();

// This router resolves its own session rather than relying on `requireAuth`, and it resolves it
// *optionally*: `loadSessionIfPresent` sets `req.user` when a valid session cookie exists and
// otherwise lets the request through untouched, so `resolveEnrollmentAuth` below can fall back to
// an enrollment grant. `requireAuth` could not be used here because it rejects a request with no
// session, and a grant-only request is exactly the case that must get through.
router.use(loadSessionIfPresent);

// ------------------------------------------------------------------
// Authentication for this router
// ------------------------------------------------------------------
// Three things require a student identity here, and they are reached by two different proofs:
//
//   * an already-enrolled student with a session, managing their device; and
//   * a student with NO active device, who has proved a matric number + password and is
//     holding a scoped enrollment grant so they can register their first device.
//
// `requireAuth` is deliberately NOT applied at router level and is NOT extended to accept a
// grant. `requireAuth` is the gate on every normal student API, and a grant must never satisfy
// it: the whole point of the grant is that first-device enrollment does not need, and must not
// hand out, a session.
//
// The UPGRADE ceremony (replacing a non-discoverable legacy credential) is session-only. The
// grant path is checked below to require state `ENROLL`, which is what keeps a password-only
// login from ever replacing an active device.
// ------------------------------------------------------------------

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "UNAUTHENTICATED",
    message: "Authentication required.",
  });
}

function deviceConflict(res: Response): void {
  res.status(409).json({
    error: "DEVICE_ALREADY_ENROLLED",
    message:
      "A device is already enrolled for this account. An administrator must reset it before a new device can be enrolled.",
  });
}

function forbidden(res: Response): void {
  res.status(403).json({
    error: "FORBIDDEN",
    message: "You do not have permission to access this resource.",
  });
}

/**
 * Resolve the caller, enforcing the rule that a grant may only bootstrap a *first* device.
 *
 * A grant is issued only when the student has no ACTIVE device, but the world can move in
 * between: the student may enrol from another tab, or an admin may act. Re-checking here means the
 * grant is never a standing permission to replace an active device.
 *
 * When an active device is present the grant is refused rather than honoured, and the grant cookie
 * is cleared so a stale credential is not left in the browser.
 */
async function authorizeEnrollment(
  req: Request,
  res: Response
): Promise<EnrollmentAuthContext | null> {
  const resolved = await resolveEnrollmentAuth(req);
  if (!resolved.ok) {
    unauthorized(res);
    return null;
  }

  // These are student device routes. The grant path is already constrained to students by
  // `resolveEnrollmentGrant` (it joins on role = 'STUDENT'), but the session path is not, so the
  // role is checked here. Without it a lecturer or admin session would fall through to the
  // student lookups and get a confusing 404 instead of a 403.
  if (resolved.auth.method === "SESSION" && req.user?.role !== "STUDENT") {
    forbidden(res);
    return null;
  }

  const { auth } = resolved;

  if (auth.method === "GRANT") {
    const status = await getStudentDeviceStatus(auth.userId);
    const hasActiveDevice = status.ok && status.state !== "ENROLL";
    if (!status.ok || hasActiveDevice) {
      res.clearCookie(
        authConfig.enrollmentGrantCookieName,
        clearEnrollmentGrantCookieOptions
      );
      deviceConflict(res);
      return null;
    }
  }

  return auth;
}

// ------------------------------------------------------------------
// GET /api/student/device
// Read-only report of the student's current device state, so the UI can
// render the right state without starting a ceremony.
//
// This endpoint is intentionally side-effect free: it creates, consumes and
// expires no challenge, writes no device row, and does not touch the
// attendance challenge. In particular it must never be implemented in terms of
// the enrollment-options endpoint below, which issues a challenge and
// expires the student's existing one.
// ------------------------------------------------------------------
router.get("/device", async (req, res) => {
  try {
    const auth = await authorizeEnrollment(req, res);
    if (auth === null) {
      return;
    }

    const result = await getStudentDeviceStatus(auth.userId);

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
    const auth = await authorizeEnrollment(req, res);
    if (auth === null) {
      return;
    }

    const result = await startDeviceEnrollment(auth.userId);

    if (!result.ok) {
      switch (result.code) {
        case "STUDENT_NOT_FOUND":
          return res.status(404).json({
            error: "STUDENT_NOT_FOUND",
            message: "The authenticated user does not belong to a student profile.",
          });
        case "DEVICE_ALREADY_ENROLLED":
          return deviceConflict(res);
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
//
// This is the only place a session is ever created for the grant path. It happens after the
// ceremony has committed, so a student can never hold a normal session that has not been
// paired with a registered device.
// ------------------------------------------------------------------
router.post("/device/enrollment/complete", async (req, res) => {
  // Authorization runs before the body is validated. An anonymous caller must be told 401, not
  // 400: telling an unauthenticated caller their payload is malformed leaks that the endpoint is
  // reachable and invites them to keep guessing at the shape.
  let auth: EnrollmentAuthContext | null;
  try {
    auth = await authorizeEnrollment(req, res);
  } catch (error) {
    console.error("Device enrollment authorization error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while completing device enrollment.",
    });
    return;
  }
  if (auth === null) {
    return;
  }

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
      auth.userId,
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
          return deviceConflict(res);
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

    if (auth.method === "GRANT" && auth.grantToken !== null) {
      // Spend the grant. The device row is already committed by
      // `completeDeviceEnrollment`, so this is bookkeeping, not a gate: the one-ACTIVE-device
      // constraint already prevents a second device from being created. Losing the race here
      // therefore cannot leave the student without a usable device, it only means the grant was
      // already consumed elsewhere and this browser no longer needs it.
      await consumeEnrollmentGrant(auth.grantToken);

      // Promote the grant into a normal session, now that a device is genuinely registered.
      const token = generateSessionToken();
      await createSession(
        auth.userId,
        hashSessionToken(token),
        new Date(Date.now() + authConfig.sessionLifetimeMs)
      );
      res.cookie(authConfig.cookieName, token, authConfig.cookie);

      // The grant is spent: clear it so it is never presented again.
      res.clearCookie(
        authConfig.enrollmentGrantCookieName,
        clearEnrollmentGrantCookieOptions
      );
    }

    // Whether this completion also established a normal student session. False on the
    // session-authenticated path, where the caller already had one; true when an enrollment
    // grant was promoted into a session. Lets the client know whether to re-sync its auth state.
    const sessionCreated = auth.method === "GRANT" && auth.grantToken !== null;

    res.status(201).json({
      credentialId: result.credentialId,
      // Present only for an upgrade, and always null otherwise. The old credential row is
      // REVOKED, not deleted.
      replacedCredentialId: result.replacedCredentialId,
      // False means the authenticator ignored `residentKey: "required"`. The credential is
      // still usable for attendance; the student can run the upgrade again.
      discoverable: result.discoverable,
      device: result.device,
      sessionCreated,
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
