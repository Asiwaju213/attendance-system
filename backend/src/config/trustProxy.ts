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
 *
 * TODO(render): this value was chosen for the former Vercel Function
 * architecture, where the edge was the only proxy in front of Express. The
 * production topology is now Vercel (static frontend) -> Render Web Service
 * (Express), which introduces a second proxy and therefore a forwarded-header
 * chain of a different length. `1` is very likely wrong there: it would report
 * the address of Vercel's edge as `req.ip`, collapsing distinct users onto a
 * small rotating set of proxy addresses and weakening IP-based rate limiting.
 *
 * Do NOT simply change the constant on the strength of that reasoning. The real
 * value depends on whether Render preserves the `X-Forwarded-For` header Vercel
 * sends and appends its own entry, which cannot be known until a Render service
 * exists. Until then this stays as it is, because guessing either way would be
 * worse than the current known-imperfect value: too low a count is a rate-limit
 * weakness, and `true` would let a client choose its own `req.ip`.
 *
 * To resolve it, deploy to Render, send one request through the real Vercel
 * rewrite, and observe the actual header chain (see
 * `docs/render-neon-deployment.md`, "Verify the real X-Forwarded-For
 * behavior"). Then set the count to match, and update this comment and
 * `backend/tests/trustProxy.test.ts` together.
 *
 * Note that this setting has no effect on session cookies: `Secure` is derived
 * from `AUTH_COOKIE_SECURE`/`NODE_ENV` in `config/auth.ts`, and no code reads
 * `req.protocol`, `req.secure` or `req.hostname`.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * Applied during application initialization, before any middleware or route can
 * read `req.ip`.
 */
export function applyTrustProxy(app: Express): void {
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
}
