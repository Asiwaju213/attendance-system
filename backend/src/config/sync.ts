import { createHash } from "node:crypto";

/**
 * Configuration for cloud -> local K12 edge synchronization.
 *
 * The same build runs on both sides, so one module resolves both roles and the
 * two are switched on completely independently:
 *
 *   provider (cloud / Render)  serves the change feed over HTTP.
 *                              Configured by SYNC_PROVIDER_SECRET_HASH. It
 *                              never reads SYNC_CLOUD_BASE_URL and never starts
 *                              the worker.
 *
 *   consumer (local K12 PC)    runs the background worker that pulls the feed.
 *                              Configured by SYNC_ENABLED plus the
 *                              SYNC_CLOUD_* / SYNC_EDGE_* variables. It never
 *                              needs SYNC_PROVIDER_SECRET_HASH.
 *
 * An unset variable means "absent", matching config/database.ts. Every failure
 * names the offending variable so a misconfigured PC is diagnosable from the
 * server log alone.
 */

const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 3_600_000;

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 500;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

/** Schema version of the feed payload, so an edge can reject what it cannot read. */
export const SYNC_PAYLOAD_VERSION = 1;

/** Version for session events after removing network/location session metadata. */
export const SYNC_ATTENDANCE_SESSION_VERSION = 2;

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function readOptional(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  throw new Error(
    `Invalid value for ${name}: expected one of true, false, 1, 0, yes, no, on, off.`
  );
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid value for ${name}: expected an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptional(env, name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * SHA-256 hex digest of the shared edge secret.
 *
 * Both sides compute the same digest of the same secret, so the provider can be
 * configured with the digest alone and never has the raw value in its
 * environment. That is what makes a leaked provider configuration useless to an
 * attacker: possessing the digest does not let them produce the `Authorization`
 * header.
 *
 * Reusing `hashSessionToken` from lib/sessions is deliberate. That function is
 * already this codebase's general "SHA-256 hex of a bearer secret" helper - it
 * is already used for enrollment grants and device-login challenges - so this
 * adds no new crypto primitive and keeps the digests comparable.
 */
export function hashEdgeSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Reject anything that is not an http(s) origin.
 *
 * SYNC_CLOUD_BASE_URL is a full outbound destination supplied by configuration,
 * so it is validated rather than trusted: a typo must fail at startup instead of
 * sending the edge's credential in a request header to a nonsense host.
 */
function resolveCloudBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = requireEnv(env, "SYNC_CLOUD_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "Invalid value for SYNC_CLOUD_BASE_URL: expected an absolute http(s) URL such as https://api.example.com."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid value for SYNC_CLOUD_BASE_URL: unsupported protocol "${parsed.protocol}". Use http or https.`
    );
  }
  // The trailing slash is stripped so the worker can join a path onto the base
  // without producing a double slash.
  return raw.replace(/\/+$/, "");
}

export interface SyncProviderConfig {
  /** SHA-256 hex of the accepted edge secret, or null when the feed is disabled. */
  secretHash: string | null;
  batchLimit: number;
}

export interface SyncConsumerConfig {
  /** False means "this process does not run a sync worker". */
  enabled: boolean;
  consumerId: string;
  cloudBaseUrl: string;
  /** The raw edge secret. Held in memory only; never logged, never returned. */
  edgeSecret: string;
  intervalMs: number;
  batchLimit: number;
  requestTimeoutMs: number;
}

export interface SyncConfig {
  payloadVersion: number;
  provider: SyncProviderConfig;
  consumer: SyncConsumerConfig;
}

export function resolveSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const batchLimit = optionalInteger(
    env,
    "SYNC_BATCH_LIMIT",
    DEFAULT_BATCH_LIMIT,
    1,
    MAX_BATCH_LIMIT
  );

  // A malformed digest is rejected rather than silently treated as "no feed":
  // a typo in configuration should be loud, not an outage discovered later.
  const rawSecretHash = readOptional(env, "SYNC_PROVIDER_SECRET_HASH");
  let secretHash: string | null = null;
  if (rawSecretHash !== undefined) {
    const normalized = rawSecretHash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(
        "Invalid value for SYNC_PROVIDER_SECRET_HASH: expected a 64-character SHA-256 hex digest."
      );
    }
    secretHash = normalized;
  }

  // The worker is opt-in and inert until it is fully configured. Requiring all
  // three of the URL, id and secret means enabling it can never produce a
  // half-configured worker that silently syncs nothing.
  const workerRequested = optionalBoolean(env, "SYNC_ENABLED", false);
  const consumerId = readOptional(env, "SYNC_EDGE_ID");
  const edgeSecret = readOptional(env, "SYNC_EDGE_SECRET");
  const cloudBaseUrl =
    readOptional(env, "SYNC_CLOUD_BASE_URL") !== undefined
      ? resolveCloudBaseUrl(env)
      : "";

  const consumerEnabled = workerRequested;

  if (consumerEnabled && consumerId === undefined) {
    throw new Error(
      "Missing required environment variable: SYNC_EDGE_ID (required when SYNC_ENABLED is set)."
    );
  }
  if (consumerEnabled && edgeSecret === undefined) {
    throw new Error(
      "Missing required environment variable: SYNC_EDGE_SECRET (required when SYNC_ENABLED is set)."
    );
  }
  if (consumerEnabled && cloudBaseUrl === "") {
    throw new Error(
      "Missing required environment variable: SYNC_CLOUD_BASE_URL (required when SYNC_ENABLED is set)."
    );
  }

  return {
    payloadVersion: SYNC_PAYLOAD_VERSION,
    provider: {
      secretHash,
      batchLimit,
    },
    consumer: {
      enabled: consumerEnabled,
      // Placeholders are only ever read when `enabled` is false, in which case
      // the worker is never started. They keep the object total rather than
      // forcing null-handling through every call site.
      consumerId: consumerId ?? "",
      cloudBaseUrl,
      edgeSecret: edgeSecret ?? "",
      intervalMs: optionalInteger(
        env,
        "SYNC_INTERVAL_MS",
        DEFAULT_INTERVAL_MS,
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS
      ),
      batchLimit,
      requestTimeoutMs: optionalInteger(
        env,
        "SYNC_REQUEST_TIMEOUT_MS",
        DEFAULT_REQUEST_TIMEOUT_MS,
        MIN_REQUEST_TIMEOUT_MS,
        MAX_REQUEST_TIMEOUT_MS
      ),
    },
  };
}

export const syncConfig = resolveSyncConfig(process.env);