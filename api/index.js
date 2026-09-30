/**
 * Vercel serverless function entrypoint.
 *
 * Vercel maps this file to the `/api` path, so `vercel.json` rewrites
 * `/api/<anything>` here and the existing relative `/api/...` calls in the
 * frontend keep working against the same origin, with no CORS.
 *
 * The Express application itself is NOT re-declared here. `backend/src/app.ts`
 * stays the single source of truth for middleware and route registration, and
 * this file only hands that same instance to Vercel. There is therefore one
 * Express app in the project, not two.
 *
 * `backend/dist/app.js` is the compiled output of the existing root build
 * (`npm run build`, which builds the backend before the frontend), so the
 * deployed function is the same artifact that is built and tested locally. This
 * file is intentionally plain CommonJS JavaScript: the backend is already
 * `"type": "commonjs"`, and adding a second TypeScript compilation path here
 * would give the cloud a different build from the one the project verifies.
 *
 * This file must never import `backend/dist/index.js`. That module calls
 * `app.listen()` and runs the startup database connectivity check, both of
 * which are for the long-running local/LAN server only. Vercel owns the
 * listening socket and supplies the request handler, so the function has to
 * stay free of `listen()`.
 *
 * Importing the app also constructs the `pg` connection pool declared in
 * `backend/src/db/pool.ts`. `pg.Pool` opens no socket until the first query, so
 * nothing connects at import time. No migration, seed, cleanup or reset runs
 * here; migrations stay a separate, explicit local script.
 */

const fs = require("node:fs");
const path = require("node:path");

const appModulePath = path.join(__dirname, "..", "backend", "dist", "app.js");

if (!fs.existsSync(appModulePath)) {
  throw new Error(
    `Missing ${appModulePath}. The Vercel build command must run "npm run build" at the repository root before the function is bundled.`
  );
}

const { app } = require(appModulePath);

// An Express application is already a (req, res) handler, which is exactly the
// signature Vercel invokes. Handing it over unchanged avoids wrapping the app in
// another layer of request handling.
module.exports = app;
