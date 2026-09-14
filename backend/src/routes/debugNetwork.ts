import { Router } from "express";

/**
 * ============================================================================
 * TEMPORARY — network observation endpoint (investigation / prototype only).
 * ============================================================================
 *
 * Purpose: report exactly what network/request information Express can observe
 * for a client, so we can compare a phone on the MAN 4G Router K12, a phone on
 * mobile data, and a laptop on the router.
 *
 * This is NOT the final student network restriction. It does not block anyone,
 * it does not touch authentication/authorization, and it must be removed once
 * the investigation is finished. Delete this file and its two mount lines in
 * `app.ts`, plus the `/network-test` frontend route/page, to remove it.
 *
 * Deliberately returns only whitelisted, non-sensitive fields. It never returns
 * cookies, session tokens, Authorization headers, passwords, or app data.
 */

const router = Router();

// The Vite dev server proxies `/api` to this backend, so requests made through
// the frontend appear to come from the proxy (127.0.0.1), hiding the real client.
// To observe the true client address, the temp page may also call this endpoint
// directly cross-origin. Allow that for THIS debug route only (GET, no cookies).
router.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

router.options("/network", (_req, res) => {
  res.sendStatus(204);
});

function describeTrustProxy(value: unknown): string {
  if (value === true) {
    return "enabled (all proxies trusted) — req.ip/req.ips may reflect X-Forwarded-For";
  }
  if (value === false || value === undefined) {
    return "disabled (default) — req.ip is the direct socket peer; forwarded headers are NOT trusted";
  }
  if (typeof value === "number") {
    return `enabled for the first ${value} hop(s)`;
  }
  if (typeof value === "string") {
    return `set to: ${value}`;
  }
  if (Array.isArray(value)) {
    return `set to list: ${value.join(", ")}`;
  }
  return "custom trust proxy function";
}

function headerValue(
  value: string | string[] | undefined
): string | string[] | null {
  return value === undefined ? null : value;
}

// GET /api/debug/network — intentionally NOT behind requireAuth.
router.get("/network", (req, res) => {
  const trustProxy = req.app.get("trust proxy");
  const socket = req.socket;

  res.status(200).json({
    data: {
      // What Express reports after applying the trust proxy setting.
      ip: req.ip ?? null,
      ips: Array.isArray(req.ips) ? req.ips : [],
      protocol: req.protocol,
      secure: req.secure,
      hostname: req.hostname,

      // Report the trust proxy configuration clearly, because it directly
      // affects what `ip`/`ips` above mean.
      trustProxy: trustProxy ?? false,
      trustProxyExplanation: describeTrustProxy(trustProxy),

      // Only the headers we explicitly care about. No cookies/auth headers.
      headers: {
        host: headerValue(req.headers["host"]),
        "x-forwarded-for": headerValue(req.headers["x-forwarded-for"]),
        "x-real-ip": headerValue(req.headers["x-real-ip"]),
        forwarded: headerValue(req.headers["forwarded"]),
        "user-agent": headerValue(req.headers["user-agent"]),
      },

      // Raw transport-level details, which do NOT depend on trust proxy.
      connection: {
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
        remoteFamily: socket.remoteFamily ?? null,
        localAddress: socket.localAddress ?? null,
        localPort: socket.localPort ?? null,
        encrypted: Boolean((socket as { encrypted?: boolean }).encrypted),
      },
    },
  });
});

export default router;
