import type { Express } from "express";

/**
 * Reverse-proxy trust configuration.
 *
 * The deployed API will sit behind exactly one reverse proxy (Vercel's edge) in
 * front of the Express application. Without any trust setting Express ignores
 * `X-Forwarded-For` entirely and reports the proxy's own socket address as
 * `req.ip`, which would collapse every visitor into a single rate-limit bucket.
 *
 * One hop, and only one, is the whole point:
 *
 *   - `true` would trust an arbitrary-length chain, letting a client prepend
 *     forged addresses to `X-Forwarded-For` and choose the address Express
 *     believes, defeating IP-based rate limiting.
 *   - `0` would trust nothing, which is today's behaviour and the bug.
 *
 * `1` makes Express read the single address that the trusted proxy itself
 * appended, and ignore anything to its left. A proxy appends the real client
 * address as the last entry, so a client-supplied entry sitting to the left of
 * it cannot influence the result.
 *
 * This is deliberately a constant rather than an environment variable. A
 * variable here would be a way to silently disable IP-based rate limiting in
 * production, and there is no deployment of this application that needs a
 * different number of hops.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * Applied during application initialization, before any middleware or route can
 * read `req.ip`.
 */
export function applyTrustProxy(app: Express): void {
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
}
