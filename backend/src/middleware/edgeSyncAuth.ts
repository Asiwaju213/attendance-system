import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { syncConfig, hashEdgeSecret } from "../config/sync";

/**
 * Authentication for the edge -> cloud sync client.
 *
 * This is deliberately a completely separate mechanism from every other
 * authenticator in the application. It does not read cookies, does not consult
 * the session table, and knows nothing about WebAuthn or device binding, so
 * there is no path by which a student, lecturer or admin session - or a stolen
 * browser cookie - can reach the sync feed. A request authenticates here only by
 * presenting the shared edge secret, and a request that presents nothing is
 * rejected without any database lookup at all.
 *
 * The cloud holds only `SYNC_PROVIDER_SECRET_HASH`, the SHA-256 hex digest of the
 * secret. An attacker who reads the cloud's configuration therefore still cannot
 * authenticate, because possessing the digest does not let them reconstruct the
 * `Authorization` header value.
 */

/**
 * Compare two hex digests without leaking their contents through timing.
 *
 * Both inputs are SHA-256 hex, so they are always the same length. The length is
 * still checked first because `timingSafeEqual` throws rather than returning
 * false on a mismatch, and a throw here would surface as a 500.
 */
function digestsMatch(presentedDigest: string, expectedDigest: string): boolean {
  const presented = Buffer.from(presentedDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}

/**
 * Extract the bearer value from an Authorization header.
 *
 * Returns null for anything that is not exactly `Bearer <value>`, including a
 * missing header, so a malformed header is rejected on the same path as a wrong
 * secret rather than reaching the digest comparison.
 */
function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const separator = header.indexOf(" ");
  if (separator === -1) {
    return null;
  }
  const scheme = header.slice(0, separator).toLowerCase();
  const value = header.slice(separator + 1).trim();
  if (scheme !== "bearer" || value === "") {
    return null;
  }
  return value;
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "SYNC_UNAUTHORIZED",
    message: "A valid edge synchronization credential is required.",
  });
}

export function requireEdgeSyncAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expectedDigest = syncConfig.provider.secretHash;

  // Fail closed and distinctly: an unconfigured provider must never fall
  // through to "no credential required". 503 (rather than 401) tells the
  // operator the cloud side is misconfigured, not that the edge is wrong.
  if (expectedDigest === null) {
    res.status(503).json({
      error: "SYNC_NOT_CONFIGURED",
      message: "The synchronization feed is not enabled on this deployment.",
    });
    return;
  }

  const token = readBearerToken(req);
  if (token === null) {
    unauthorized(res);
    return;
  }

  if (!digestsMatch(hashEdgeSecret(token), expectedDigest)) {
    unauthorized(res);
    return;
  }

  next();
}