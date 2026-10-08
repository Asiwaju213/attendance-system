/**
 * Deployment-mode configuration for student access.
 *
 * The same backend build runs in two places, and they split the student surface:
 *
 *   cloud (Render)   the public deployment, reachable from the open Internet through the Vercel
 *                    rewrite. Only account setup is served here: a newly registered student can
 *                    complete course registration and WebAuthn device enrollment, but can never
 *                    sign in or mark attendance from anywhere in the world.
 *
 *   edge (K12 PC)    the authoritative entry point for students, on the campus router's own
 *                    network. The full student surface is served here: sign-in, attendance and
 *                    every other student API.
 *
 * The split - which web routes the cloud may and may not serve - is enforced by
 * middleware/studentAccess.ts, which holds the cloud allowlists.
 *
 * This is an explicit operator decision recorded as one environment variable, not something the
 * server infers from a request:
 *
 *   - It is NOT an IP allowlist. The deployed API sits behind proxies (Vercel in front of Render),
 *     so `req.ip` is a proxy address whose meaning is already documented as uncertain in
 *     config/trustProxy.ts. A policy built on it would either lock every student out or trust a
 *     header a client can influence. No code here reads `req.ip`.
 *   - It is NOT derived from SYNC_ENABLED. That variable means "run the background sync worker"
 *     (config/sync.ts); a PC syncing but not serving students, or the reverse, must both be
 *     expressible, and repurposing it would make a synchronization setting silently a network
 *     policy.
 *   - It is NOT derived from HOST or PORT. Those only choose the listening socket
 *     (config/server.ts), and both deployments bind 0.0.0.0, so they cannot tell them apart.
 *
 * Unset means `cloud`: fail closed. A variable that is missing, misspelled or left at its default
 * must never be the thing that exposes student sign-in or attendance to the Internet. An
 * unrecognized value fails at startup instead, so a typo is loud rather than quietly permissive.
 */

// Loads config/env, which runs dotenv.config(). The process-wide value below is resolved when
// this module is first evaluated, so the dependency on dotenv has to be declared here: relying on
// the importer's order is what let app.ts pull config/access in before ./db/pool (the module that
// pulls in config/env), so .env was read only after the mode had already been fixed to `cloud`.
import "./env";

export const STUDENT_ACCESS_MODES = ["cloud", "edge"] as const;

export type StudentAccessMode = (typeof STUDENT_ACCESS_MODES)[number];

/**
 * The mode used when STUDENT_ACCESS_MODE is absent or blank.
 *
 * `cloud`, deliberately: a deployment that has not been told it is the edge must not serve
 * students.
 */
export const DEFAULT_STUDENT_ACCESS_MODE: StudentAccessMode = "cloud";

/** The one variable that selects the mode. Named here so the setting key has one definition. */
export const STUDENT_ACCESS_MODE_ENV_VAR = "STUDENT_ACCESS_MODE";

/** Express application setting key holding the mode in force for that app instance. */
export const STUDENT_ACCESS_MODE_SETTING = "studentAccessMode";

/**
 * Resolve the mode from an environment.
 *
 * Exported separately from the process-wide value so tests can assert every branch without
 * mutating `process.env`, which is the convention the other config modules here follow
 * (resolveServerConfig, resolveCookieSecure, resolveSyncConfig).
 */
export function resolveStudentAccessMode(env: NodeJS.ProcessEnv = process.env): StudentAccessMode {
  const raw = env[STUDENT_ACCESS_MODE_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_STUDENT_ACCESS_MODE;
  }

  const value = raw.trim().toLowerCase();
  if (value === "cloud" || value === "edge") {
    return value;
  }

  throw new Error(
    `Invalid value for ${STUDENT_ACCESS_MODE_ENV_VAR}: "${raw}". Use cloud or edge. ` +
      `cloud disables student sign-in and student APIs (the public deployment); ` +
      `edge enables them (the K12 PC on the campus network).`
  );
}

/** Whether students may authenticate and use student APIs in this mode. */
export function studentAccessEnabled(mode: StudentAccessMode): boolean {
  return mode === "edge";
}

export interface StudentAccessConfig {
  mode: StudentAccessMode;
  studentAccessEnabled: boolean;
}

export function resolveStudentAccessConfig(
  env: NodeJS.ProcessEnv = process.env
): StudentAccessConfig {
  const mode = resolveStudentAccessMode(env);
  return { mode, studentAccessEnabled: studentAccessEnabled(mode) };
}

/**
 * The value resolved once for this process, from the environment.
 *
 * Read at import time, which is why this module imports config/env above: dotenv must have run
 * before this line executes, whatever the order the rest of the application imports in. The same
 * value feeds both the startup log in index.ts and the Express setting app.ts installs, so the
 * log and the middleware can never disagree.
 */
export const studentAccessConfig: StudentAccessConfig = resolveStudentAccessConfig(process.env);

/**
 * Startup log line, in the style of describeServerConfig in config/server.ts.
 *
 * Says which mode is in force and what it means operationally, and names the variable so a
 * misconfigured deployment is diagnosable from the server log alone. Contains no secrets and no
 * addresses.
 */
export function describeStudentAccessConfig(config: StudentAccessConfig): string {
  if (config.studentAccessEnabled) {
    return (
      `Student access is ENABLED: this process is the K12 edge, so student sign-in and ` +
      `student APIs are served. Students must reach this deployment over the campus network; ` +
      `keep it off the open Internet at the router/firewall.`
    );
  }
  return (
    `Student access is DISABLED: this is a cloud/provider deployment, so student sign-in and ` +
    `attendance are refused. Account setup stays available here for newly registered students ` +
    `(course registration and device enrollment). Set ${STUDENT_ACCESS_MODE_ENV_VAR}=edge on the ` +
    `K12 edge PC to serve the full student surface.`
  );
}
