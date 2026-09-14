import { Request, Response, Router } from "express";
import { authConfig, clearCookieOptions } from "../config/auth";
import { hashPassword } from "../lib/passwords";
import { hashSessionToken } from "../lib/sessions";
import { getSessionToken, requireAuth } from "../middleware/authenticate";
import { authenticate } from "../services/authService";
import {
  completeRegistration,
  verifyRegistration,
} from "../services/studentRegistrationService";
import { findSafeUserById } from "../services/userStore";
import {
  findSessionByTokenHash,
  isSessionActive,
  revokeSession,
} from "../services/sessionStore";
import { Role } from "../types/auth";
import { parseLoginCredentials } from "../validation/authValidation";
import {
  parseCompleteRegistration,
  parseVerifyRegistration,
} from "../validation/studentRegistrationValidation";

const router = Router();

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

router.post("/student/login", buildLoginHandler("STUDENT", "matricNumber"));
router.post("/lecturer/login", buildLoginHandler("LECTURER", "staffId"));
router.post("/admin/login", buildLoginHandler("ADMIN", "username"));

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

  res.clearCookie(authConfig.cookieName, clearCookieOptions);
  res.status(200).json({ message: "Logged out." });
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