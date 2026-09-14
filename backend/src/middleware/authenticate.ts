import { NextFunction, Request, RequestHandler, Response } from "express";
import { authConfig } from "../config/auth";
import { hashSessionToken } from "../lib/sessions";
import { findSessionByTokenHash, isSessionActive, updateLastSeen } from "../services/sessionStore";
import { findActiveUserById } from "../services/userStore";
import { Role } from "../types/auth";

function getCookieValue(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export function getSessionToken(req: Request): string | null {
  const token = getCookieValue(req, authConfig.cookieName);
  return token ? token : null;
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "UNAUTHENTICATED",
    message: "Authentication required.",
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getSessionToken(req);
    if (!token) {
      unauthorized(res);
      return;
    }

    const session = await findSessionByTokenHash(hashSessionToken(token));
    if (!session || !isSessionActive(session)) {
      unauthorized(res);
      return;
    }

    const user = await findActiveUserById(session.user_id);
    if (!user) {
      unauthorized(res);
      return;
    }

    req.user = user;
    updateLastSeen(session.id).catch(() => undefined);
    next();
  } catch (error) {
    console.error("Authentication check failed.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
  }
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      unauthorized(res);
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "You do not have permission to access this resource.",
      });
      return;
    }
    next();
  };
}

export const requireAdmin = requireRole("ADMIN");
export const requireLecturer = requireRole("LECTURER");
export const requireStudent = requireRole("STUDENT");