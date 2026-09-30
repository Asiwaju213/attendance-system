import { Request, Response, Router } from "express";
import { authConfig, clearCookieOptions, clearRememberedAccountCookieOptions, clearDeviceBindingCookieOptions } from "../config/auth";
import { hashPassword } from "../lib/passwords";
import { hashSessionToken } from "../lib/sessions";
import { getSessionToken, requireAuth, getCookieValue } from "../middleware/authenticate";
import { authenticate, findLoginCandidate, verifyPasswordOrDummy, generateSessionToken, createSession, toSafeUser } from "../services/authService";
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
  findStudentLoginCandidateByCredentialId,
  isDiscoverableCredential,
} from "../services/studentDeviceStore";
import {
  findSessionByTokenHash,
  isSessionActive,
  revokeSession,
} from "../services/sessionStore";
import { Role } from "../types/auth";
import { parseLoginCredentials } from "../validation/authValidation";
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
    
    // For student login, set a long-lived remembered account cookie so returning
    // students can skip the matric number entry on subsequent visits. The cookie
    // is HTTP-only and secure; the matric number is never exposed to JavaScript.
    if (role === "STUDENT") {
      res.cookie(
        authConfig.rememberedAccountCookieName,
        credentials.identifier,
        authConfig.rememberedAccountCookie
      );
    }
    
    res.status(200).json({ user: result.safeUser });
  };
}

// Student login with device-binding support.
// If a valid device-binding cookie is present, the credential ID from the cookie
// identifies the student, and only the password is required from the request body.
// If no valid device-binding cookie, falls back to matric+password login.
router.post("/student/login", async (req: Request, res: Response): Promise<void> => {
  const credentialId = getCookieValue(req, authConfig.deviceBindingCookieName);
  let identifier: string;
  let password: string;

  if (credentialId && typeof credentialId === "string" && credentialId.trim() !== "") {
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

    const candidate = await findStudentLoginCandidateByCredentialId(credentialId.trim());
    if (
      candidate === null ||
      candidate.deviceStatus !== "ACTIVE" ||
      !isDiscoverableCredential(candidate) ||
      candidate.userRole !== "STUDENT" ||
      candidate.userStatus !== "ACTIVE"
    ) {
      // Device binding is invalid (revoked, non-discoverable, or student inactive).
      // Clear the cookie and fall back to generic failure.
      res.clearCookie(authConfig.deviceBindingCookieName, clearDeviceBindingCookieOptions);
      await verifyPasswordOrDummy(null, password);
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    identifier = candidate.identifier;
  } else {
    // No device-binding cookie: fall back to matric+password login.
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

  const token = generateSessionToken();
  await createSession(
    candidate.id,
    hashSessionToken(token),
    new Date(Date.now() + authConfig.sessionLifetimeMs)
  );

  res.cookie(authConfig.cookieName, token, authConfig.cookie);

  // If this was a device-bound login, refresh the device-binding cookie
  if (credentialId) {
    res.cookie(
      authConfig.deviceBindingCookieName,
      credentialId.trim(),
      authConfig.deviceBindingCookie
    );
  }

  const safeUser = toSafeUser({ ...candidate, role: "STUDENT" });
  res.status(200).json({ user: safeUser });
});

router.post("/lecturer/login", buildLoginHandler("LECTURER", "staffId"));
router.post("/admin/login", buildLoginHandler("ADMIN", "username"));

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

router.post("/student/register/verify", async (req: Request, res: Response) => {
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
// The binding is determined by the device-binding cookie (credential ID)
// and verified against the database (ACTIVE, discoverable, student ACTIVE).
router.get("/student/device-binding", async (req: Request, res: Response) => {
  const credentialId = getCookieValue(req, authConfig.deviceBindingCookieName);
  if (!credentialId || typeof credentialId !== "string" || credentialId.trim() === "") {
    return res.status(200).json({ hasDeviceBinding: false });
  }

  const candidate = await findStudentLoginCandidateByCredentialId(credentialId.trim());
  if (
    candidate === null ||
    candidate.deviceStatus !== "ACTIVE" ||
    !isDiscoverableCredential(candidate) ||
    candidate.userRole !== "STUDENT" ||
    candidate.userStatus !== "ACTIVE"
  ) {
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