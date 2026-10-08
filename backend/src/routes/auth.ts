import { Request, Response, Router } from "express";
import {
  authConfig,
  clearCookieOptions,
  clearRememberedAccountCookieOptions,
  clearDeviceBindingCookieOptions,
  clearEnrollmentGrantCookieOptions,
} from "../config/auth";
import { hashPassword } from "../lib/passwords";
import { hashSessionToken } from "../lib/sessions";
import { getSessionToken, requireAuth, requireLecturer, getCookieValue } from "../middleware/authenticate";
import { authenticate, findLoginCandidate, verifyPasswordOrDummy, generateSessionToken, createSession, toSafeUser } from "../services/authService";
import { changeOwnPassword } from "../services/passwordChangeService";
import {
  completeRegistration,
  verifyRegistration,
} from "../services/studentRegistrationService";
import {
  checkStudentDeviceLoginAllowed,
  checkStudentDeviceLoginChallengeAllowed,
  clearStudentDeviceLoginFailures,
  completeStudentDeviceLogin,
  INVALID_DEVICE_LOGIN,
  recordStudentDeviceLoginChallengeIssued,
  recordStudentDeviceLoginFailure,
  startStudentDeviceLogin,
} from "../services/studentDeviceLoginService";
import { findSafeUserById } from "../services/userStore";
import {
  consumeStudentDeviceBootstrap,
  findStudentLoginCandidateByBinding,
  findStudentByUserId,
  hasActiveDevice,
  isDiscoverableCredential,
  type StudentDeviceBindingCandidate,
} from "../services/studentDeviceStore";
import { issueEnrollmentGrant } from "../services/studentDeviceEnrollmentGrantStore";
import {
  findSessionByTokenHash,
  isSessionActive,
  revokeSession,
} from "../services/sessionStore";
import { Role } from "../types/auth";
import { parseLoginCredentials } from "../validation/authValidation";
import { parseChangePasswordBody } from "../validation/passwordChangeValidation";
import { parseStudentDeviceLoginBody } from "../validation/studentDeviceLoginValidation";

// Parse password from request body (local copy since it's not exported from authValidation).
function parsePassword(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>).password;
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < 1 || value.length > 200) {
    return null;
  }
  return value;
}
import {
  parseCompleteRegistration,
  parseVerifyRegistration,
} from "../validation/studentRegistrationValidation";

/**
 * The one-time bootstrap secret from the request body, or null when it is not
 * a usable secret.
 *
 * The plaintext is the base64url alphabet only - `generateSessionToken` is the
 * only producer, so anything outside that alphabet was never minted here and is
 * refused before it can reach a hash comparison. The length ceiling exists so
 * an arbitrarily large body cannot be turned into a hash-comparison workload.
 */
const MAX_BOOTSTRAP_SECRET_LENGTH = 128;

function parseBootstrapSecret(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>).secret;
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < 1 || value.length > MAX_BOOTSTRAP_SECRET_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  return value;
}

const router = Router();

/**
 * Bucket for the device-login rate limiters.
 *
 * This is the socket address unless the deployment puts the API behind a trusted proxy, in
 * which case `trust proxy` (see config/trustProxy.ts) resolves it to the real client address
 * through the single hop Vercel's edge adds. Without that hop every caller would share one
 * bucket.
 */
function rateLimitKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * A single, deliberately vague failure for every device-login rejection, so the endpoint
 * cannot be used to learn whether a credential, a student or a device exists.
 */
function sendDeviceLoginFailure(res: Response): void {
  res.status(401).json({ error: INVALID_DEVICE_LOGIN });
}

/**
 * Whether a device-binding cookie resolves to a binding a student may actually
 * sign in with.
 *
 * Every gate reads local columns. The one that is source-aware is the
 * discoverable gate: it applies to a local device row exactly as it always has
 * (a credential the usernameless ceremony could never find must not gate a
 * password login either), and is skipped for a replica row, which holds a cloud
 * device's state and deliberately holds no credential - there is no discoverable
 * flag to check, and this path runs no ceremony that would need one. The proof
 * here is the binding cookie plus the password, both verified locally.
 */
function bindingGatePasses(candidate: StudentDeviceBindingCandidate): boolean {
  if (candidate.deviceStatus !== "ACTIVE") return false;
  if (
    candidate.source === "device" &&
    !isDiscoverableCredential({ discoverable: candidate.discoverable })
  ) {
    return false;
  }
  if (candidate.userRole !== "STUDENT") return false;
  if (candidate.userStatus !== "ACTIVE") return false;
  return true;
}

function buildLoginHandler(role: Role, identifierField: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const credentials = parseLoginCredentials(req.body, identifierField);
    if (!credentials) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "A valid identifier and password are required.",
      });
      return;
    }

    const result = await authenticate(
      role,
      credentials.identifier,
      credentials.password
    );
    if (!result) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    res.cookie(authConfig.cookieName, result.token, authConfig.cookie);
    res.status(200).json({ user: result.safeUser });
  };
}

// ------------------------------------------------------------------
// Decide what a matric-number + password login on an UNBOUND device may
// have. This path never proves possession of a registered authenticator, so it must never mint a
// normal student session.
//
//   no ACTIVE device  -> short-lived enrollment grant; the session is created only after the
//                        WebAuthn ceremony commits.
//   ACTIVE device     -> nothing. The existing device stays authoritative and replacement
//                        requires an admin reset.
// ------------------------------------------------------------------
async function respondWithEnrollmentDecision(
  res: Response,
  userId: number
): Promise<void> {
  const student = await findStudentByUserId(userId);
  if (!student) {
    // A STUDENT-role account with no student profile cannot enrol a device.
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return;
  }

  if (await hasActiveDevice(student.studentId)) {
    // Drop any stale grant: a browser that previously began an enrollment must not be able to
    // spend that grant now that an active device exists.
    res.clearCookie(
      authConfig.enrollmentGrantCookieName,
      clearEnrollmentGrantCookieOptions
    );
    // No session, no grant, and nothing about the enrolled device beyond the fact that
    // enrollment is unavailable. That fact is not a secret: the student needs it to know to ask
    // an administrator for a reset.
    res.status(409).json({
      error: "DEVICE_ALREADY_ENROLLED",
      message:
        "A device is already enrolled for this account. An administrator must reset it before a new device can be enrolled.",
    });
    return;
  }

  const grant = await issueEnrollmentGrant(student.studentId);
  if (!grant.ok) {
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message:
        "An unexpected error occurred while starting device enrollment.",
    });
    return;
  }

  res.cookie(
    authConfig.enrollmentGrantCookieName,
    grant.grantToken,
    authConfig.enrollmentGrantCookie
  );
  // `enrollmentRequired: true` is the whole response. No user object, no student id, no device
  // id: the caller only needs to know it must now run the enrollment ceremony.
  res.status(200).json({ enrollmentRequired: true });
}

// Student login with device-binding support.
//
// Two distinct proofs are handled here, and the difference is the security boundary:
//
//   * A valid device-binding cookie identifies the student through an opaque device reference
//     resolved against local device state. Together with the password that is the
//     existing-device proof, so it mints a normal session exactly as before.
//
//   * No device-binding cookie means only a matric number and a password. That proves nothing
//     about a device, so it never mints a session. It is either the start of a first-device
//     enrollment (see `respondWithEnrollmentDecision`) or a rejected attempt to add a second
//     device while one is already active.
router.post("/student/login", async (req: Request, res: Response): Promise<void> => {
  const bindingValue = getCookieValue(req, authConfig.deviceBindingCookieName);
  let identifier: string;
  let password: string;
  // The device's opaque reference for a device-bound login, taken from the resolved
  // candidate. Stays null on the matric + password path, where no device has been proven.
  let boundDeviceRef: string | null = null;

  if (bindingValue && typeof bindingValue === "string" && bindingValue.trim() !== "") {
    // Device-binding cookie present: use it to identify the student.
    // The request body only needs to contain the password.
    const parsedPassword = parsePassword(req.body);
    if (!parsedPassword) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Password is required.",
      });
      return;
    }
    password = parsedPassword;

    const candidate = await findStudentLoginCandidateByBinding(bindingValue.trim());
    if (candidate === null || !bindingGatePasses(candidate)) {
      // Device binding is invalid (revoked, non-discoverable, or student inactive).
      // Clear the cookie and fall back to generic failure.
      res.clearCookie(authConfig.deviceBindingCookieName, clearDeviceBindingCookieOptions);
      await verifyPasswordOrDummy(null, password);
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    identifier = candidate.identifier;
    // Refresh with the device reference, not with whatever the cookie held. A browser
    // still presenting a pre-upgrade credential-id cookie is migrated to the opaque
    // device reference on its first successful login; a replica-resolved binding is
    // written back unchanged.
    boundDeviceRef = candidate.deviceRef;
  } else {
    // No device-binding cookie: matric + password only.
    const credentials = parseLoginCredentials(req.body, "matricNumber");
    if (!credentials) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "A valid matric number and password are required.",
      });
      return;
    }
    identifier = credentials.identifier;
    password = credentials.password;
  }

  // Verify password using the existing authenticate logic (with timing-safe dummy).
  const candidate = await findLoginCandidate("STUDENT", identifier);
  if (!candidate) {
    await verifyPasswordOrDummy(null, password);
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return;
  }

  const passwordMatches = await verifyPasswordOrDummy(candidate.password_hash, password);
  if (!passwordMatches || candidate.status !== "ACTIVE") {
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return;
  }

  // Password alone is not a device proof: hand this to the enrollment decision instead of
  // creating a session.
  if (boundDeviceRef === null) {
    await respondWithEnrollmentDecision(res, candidate.id);
    return;
  }

  const token = generateSessionToken();
  await createSession(
    candidate.id,
    hashSessionToken(token),
    new Date(Date.now() + authConfig.sessionLifetimeMs)
  );

  res.cookie(authConfig.cookieName, token, authConfig.cookie);

  // A session now exists, so any outstanding enrollment grant is redundant. Clear it so the
  // browser is not left holding a credential that could start another ceremony.
  res.clearCookie(
    authConfig.enrollmentGrantCookieName,
    clearEnrollmentGrantCookieOptions
  );

  // Refresh the device-binding cookie for the verified device. Its value is the device
  // reference, which is what the lookup above resolves on the next request.
  res.cookie(
    authConfig.deviceBindingCookieName,
    boundDeviceRef,
    authConfig.deviceBindingCookie
  );

  const safeUser = toSafeUser({ ...candidate, role: "STUDENT" });
  res.status(200).json({ user: safeUser });
});

router.post("/lecturer/login", buildLoginHandler("LECTURER", "staffId"));
router.post("/admin/login", buildLoginHandler("ADMIN", "username"));

/**
 * POST /api/auth/change-password
 *
 * The one endpoint a lecturer who still owes a password change may call. It verifies the
 * temporary credential, replaces it with the confirmed new password, clears the forced-change
 * flag and revokes the account's other sessions, all in one transaction.
 *
 * Mounted inside this router on purpose: the forced-change guard in `app.ts` runs after the
 * auth router is matched, so this route, `/api/auth/me` and `/api/auth/logout` stay reachable
 * while every other API surface is closed to that account.
 */
router.post(
  "/change-password",
  requireAuth,
  requireLecturer,
  async (req: Request, res: Response): Promise<void> => {
    const input = parseChangePasswordBody(req.body);
    if (!input) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message:
          "Provide your current password, a new password of at least 8 characters, and the new password again to confirm it.",
      });
      return;
    }

    try {
      const result = await changeOwnPassword(
        req.user!.id,
        req.sessionId ?? null,
        input.currentPassword,
        input.newPassword
      );
      if (result.ok) {
        res.status(200).json({ message: "Password changed." });
        return;
      }

      switch (result.code) {
        case "CURRENT_PASSWORD_INVALID":
          res.status(401).json({
            error: "CURRENT_PASSWORD_INVALID",
            message: "The current password is incorrect.",
          });
          return;
        case "PASSWORD_UNCHANGED":
          res.status(400).json({
            error: "PASSWORD_UNCHANGED",
            message: "The new password must be different from the current one.",
          });
          return;
        case "PASSWORD_CHANGE_NOT_REQUIRED":
          res.status(409).json({
            error: "PASSWORD_CHANGE_NOT_REQUIRED",
            message: "This account does not have a pending password change.",
          });
          return;
        case "ACCOUNT_NOT_FOUND":
          res.status(404).json({
            error: "ACCOUNT_NOT_FOUND",
            message: "The account could not be found.",
          });
          return;
      }
    } catch (error) {
      console.error("Change password error.", (error as Error).message);
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "An unexpected error occurred while changing the password.",
      });
    }
  }
);

// ------------------------------------------------------------------
// POST /api/auth/student/device/options
// Begin device-identified student login. Returns a usernameless WebAuthn
// request: no allowCredentials, so the authenticator offers whichever
// discoverable passkey the student enrolled. The student is NOT identified
// here and no session is created — the RP does not yet know who is signing in.
// Only SHA-256 hashes of the challenge and the binding token are stored.
// ------------------------------------------------------------------
router.post("/student/device/options", async (req: Request, res: Response) => {
  const clientKey = rateLimitKey(req);

  if (!checkStudentDeviceLoginChallengeAllowed(clientKey).allowed) {
    res.status(429).json({
      error: "TOO_MANY_ATTEMPTS",
      message: "Too many sign-in attempts. Please wait and try again.",
    });
    return;
  }

  try {
    const data = await startStudentDeviceLogin();
    recordStudentDeviceLoginChallengeIssued(clientKey);
    res.status(200).json({ data });
  } catch (error) {
    console.error("Student device login options error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while starting sign-in.",
    });
  }
});

// ------------------------------------------------------------------
// POST /api/auth/student/device/verify
// Finish device-identified student login. The body carries the WebAuthn
// assertion, the binding token from /options, and the password. It carries no
// matric number, student id, user id or role: the credential inside the
// assertion is the only identity input, and it is only trusted once its
// signature has been verified against the stored public key.
// ------------------------------------------------------------------
router.post("/student/device/verify", async (req: Request, res: Response) => {
  const clientKey = rateLimitKey(req);

  if (!checkStudentDeviceLoginAllowed(clientKey).allowed) {
    res.status(429).json({
      error: "TOO_MANY_ATTEMPTS",
      message: "Too many sign-in attempts. Please wait and try again.",
    });
    return;
  }

  const input = parseStudentDeviceLoginBody(req.body);
  if (!input) {
    res.status(400).json({
      error: "INVALID_REQUEST",
      message: "A binding token, a device assertion and a password are required.",
    });
    return;
  }

  try {
    const result = await completeStudentDeviceLogin(input);

    if (!result.ok) {
      recordStudentDeviceLoginFailure(clientKey);
      sendDeviceLoginFailure(res);
      return;
    }

    clearStudentDeviceLoginFailures(clientKey);
    res.cookie(authConfig.cookieName, result.token, authConfig.cookie);
    res.status(200).json({ user: result.user });
  } catch (error) {
    recordStudentDeviceLoginFailure(clientKey);
    console.error("Student device login verify error.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred during sign-in.",
    });
  }
});

// ------------------------------------------------------------------
// POST /api/auth/student/device/bootstrap
//
// Bind THIS browser to a device the CLOUD enrolled, by spending the one-time
// bootstrap secret that the cloud's enrollment response showed the student
// exactly once (migration 022).
//
// Three proofs, all verified against local data - no call to the cloud, ever:
//
//   * matric number + password   - this caller is the student who owns the
//                                  secret. Verified with the same timing-safe
//                                  dummy as every other login.
//   * the bootstrap secret       - this caller received the enrollment
//                                  response. Checked as a SHA-256 hash against
//                                  the edge's replica row; the plaintext never
//                                  reaches the database.
//   * the replica's own checks   - inside one atomic UPDATE: unexpired,
//                                  unspent, student's device ACTIVE.
//
// On success the device-binding cookie is set to the device reference, so the
// next /student/login on this browser takes the existing-device path exactly as
// if the enrollment had happened here. No session is minted: a bootstrap proves
// possession of a secret, not a sign-in, and every login after this one still
// requires the password.
//
// Every refusal is the same generic 401 as a wrong password
// (`INVALID_CREDENTIALS`), so this endpoint cannot be used to learn whether a
// secret, a student or a device exists. Like /student/login it has no rate
// limiter: the secret is single-use and expires, and each guess costs one
// password check at most.
// ------------------------------------------------------------------
router.post(
  "/student/device/bootstrap",
  async (req: Request, res: Response): Promise<void> => {
    const credentials = parseLoginCredentials(req.body, "matricNumber");
    const secret = parseBootstrapSecret(req.body);
    if (!credentials || !secret) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "A valid matric number, password and secret are required.",
      });
      return;
    }

    const candidate = await findLoginCandidate(
      "STUDENT",
      credentials.identifier
    );
    if (!candidate) {
      // Burn a password comparison anyway so an unknown matric number and a
      // wrong password are indistinguishable from here on.
      await verifyPasswordOrDummy(null, credentials.password);
      sendDeviceLoginFailure(res);
      return;
    }

    const passwordMatches = await verifyPasswordOrDummy(
      candidate.password_hash,
      credentials.password
    );
    if (!passwordMatches || candidate.status !== "ACTIVE") {
      sendDeviceLoginFailure(res);
      return;
    }

    // The whole spend in one statement: hash match, not-yet-spent,
    // not-expired, owned by this student, device ACTIVE. Null means any of
    // those failed, and the caller cannot tell which.
    const deviceRef = await consumeStudentDeviceBootstrap(
      hashSessionToken(secret),
      candidate.id
    );
    if (deviceRef === null) {
      sendDeviceLoginFailure(res);
      return;
    }

    // The binding cookie this browser would have received from a local
    // enrollment, with the same attributes and lifetime.
    res.cookie(
      authConfig.deviceBindingCookieName,
      deviceRef,
      authConfig.deviceBindingCookie
    );
    res.status(200).json({ deviceBound: true });
  }
);

router.post("/student/register/verify", async (req: Request, res: Response): Promise<void> => {
  const input = parseVerifyRegistration(req.body);
  if (!input) {
    res
      .status(400)
      .json({ error: "INVALID_REQUEST", message: "A valid matric number is required." });
    return;
  }

  const result = await verifyRegistration(input.matricNumber);
  if (!result.ok) {
    res.status(404).json({
      error: "STUDENT_NOT_FOUND",
      message: "This matric number is not available for student registration.",
    });
    return;
  }

  res.status(200).json({ data: result.data });
});

router.post("/student/register/complete", async (req: Request, res: Response) => {
  const input = parseCompleteRegistration(req.body);
  if (!input) {
    res.status(400).json({
      error: "INVALID_REQUEST",
      message:
        "A valid challenge token and a password of at least 8 characters are required.",
    });
    return;
  }

  const passwordHash = await hashPassword(input.password);
  const result = await completeRegistration(input.challengeToken, passwordHash);
  if (!result.ok) {
    if (result.code === "INVALID_REGISTRATION_CHALLENGE") {
      res.status(400).json({
        error: "INVALID_REGISTRATION_CHALLENGE",
        message: "The registration challenge is invalid, expired, or already used.",
      });
      return;
    }
    res.status(409).json({
      error: "ALREADY_REGISTERED",
      message: "This account has already completed registration.",
    });
    return;
  }

  res.cookie(authConfig.cookieName, result.token, authConfig.cookie);
  res.status(201).json({ user: result.user });
});

router.post("/logout", async (req: Request, res: Response) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      const session = await findSessionByTokenHash(hashSessionToken(token));
      if (session && isSessionActive(session)) {
        await revokeSession(session.id);
      }
    }
  } catch (error) {
    // Logout must remain safe and idempotent; the cookie is cleared either way.
    console.error("Logout could not revoke the session.", (error as Error).message);
  }

  // Normal logout clears only the session cookie. The remembered account cookie
  // is preserved so returning students see the password-only form. To switch
  // accounts, the student uses "Use a different student" which explicitly clears
  // the remembered account cookie via /auth/student/remembered/clear.
  res.clearCookie(authConfig.cookieName, clearCookieOptions);
  // An outstanding enrollment grant is a live credential for the ceremony; signing out
  // must not leave one behind in the browser.
  res.clearCookie(
    authConfig.enrollmentGrantCookieName,
    clearEnrollmentGrantCookieOptions
  );
  res.status(200).json({ message: "Logged out." });
});

// GET /api/auth/student/remembered
// Check if there is a remembered student account for this browser.
// Returns the matric number from the HTTP-only cookie so the frontend can
// pre-fill the login form without trusting client-side storage.
router.get("/student/remembered", async (req: Request, res: Response) => {
  const matricNumber = getCookieValue(req, authConfig.rememberedAccountCookieName);
  if (matricNumber && typeof matricNumber === "string" && matricNumber.trim() !== "") {
    res.status(200).json({ hasRemembered: true, matricNumber: matricNumber.trim() });
  } else {
    res.status(200).json({ hasRemembered: false });
  }
});

// POST /api/auth/student/remembered/clear
// Clear the remembered account cookie. Used when the student chooses
// "Use a different student" on the login page.
router.post("/student/remembered/clear", async (_req: Request, res: Response) => {
  res.clearCookie(authConfig.rememberedAccountCookieName, clearRememberedAccountCookieOptions);
  res.status(200).json({ message: "Remembered account cleared." });
});

// GET /api/auth/student/device-binding
// Check if there is a valid device binding for this browser.
// Returns whether the device is enrolled and bound to a student.
// The binding is determined by the device-binding cookie (device reference, or a
// pre-upgrade credential id) and verified against local data (ACTIVE,
// discoverable for a local device, student ACTIVE).
router.get("/student/device-binding", async (req: Request, res: Response) => {
  const bindingValue = getCookieValue(req, authConfig.deviceBindingCookieName);
  if (!bindingValue || typeof bindingValue !== "string" || bindingValue.trim() === "") {
    return res.status(200).json({ hasDeviceBinding: false });
  }

  const candidate = await findStudentLoginCandidateByBinding(bindingValue.trim());
  if (candidate === null || !bindingGatePasses(candidate)) {
    // Device binding is invalid (revoked, non-discoverable, or student inactive).
    // Clear the cookie so the frontend falls back to normal login.
    res.clearCookie(authConfig.deviceBindingCookieName, clearDeviceBindingCookieOptions);
    return res.status(200).json({ hasDeviceBinding: false });
  }

  res.status(200).json({ hasDeviceBinding: true, matricNumber: candidate.identifier });
});

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    res
      .status(401)
      .json({ error: "UNAUTHENTICATED", message: "Authentication required." });
    return;
  }

  const safeUser = await findSafeUserById(user.id);
  if (!safeUser) {
    res
      .status(401)
      .json({ error: "UNAUTHENTICATED", message: "Authentication required." });
    return;
  }

  res.status(200).json({ user: safeUser });
});

export default router;