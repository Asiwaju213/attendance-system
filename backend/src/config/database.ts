import type { PoolConfig } from "pg";

export type DatabaseEnv = Record<string, string | undefined>;

export type DatabaseSource =
  | "connection-string"
  | "discrete"
  | "discrete-test-isolation";

export interface PoolSettings {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  allowExitOnIdle: boolean;
}

/**
 * Pool defaults.
 *
 * `max` deliberately differs by source. A long-running local backend has one
 * process and wants the throughput that `pg` has always given it (10), so local
 * development is unchanged. A serverless platform runs many short-lived,
 * concurrently-executing instances, each with its own pool, so the total number
 * of database connections is multiplied by the number of warm instances. 1 per
 * instance is the conservative default there and must be raised deliberately
 * against the provider's connection limit, never assumed.
 *
 * `connectionTimeoutMillis` exists so a request fails fast when the database is
 * unreachable instead of hanging for the platform's execution limit.
 * `idleTimeoutMillis` returns a frozen instance's connection to the pool.
 */
export const DATABASE_POOL_DEFAULTS = {
  discreteMax: 10,
  connectionStringMax: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
} as const;

const POOL_MAX_LIMIT = 100;
const CONNECTION_TIMEOUT_LIMIT = 600_000;
const IDLE_TIMEOUT_LIMIT = 3_600_000;

/**
 * The only `sslmode` accepted in a `DATABASE_URL`.
 *
 * `pg` merges the parsed connection string *over* the options passed to the
 * client (`Object.assign({}, config, parse(config.connectionString))` in
 * `pg/lib/connection-parameters.js`), so anything the URL asks for wins over
 * this module. `pg-connection-string` translates `sslmode=require` and
 * `sslmode=prefer` into `ssl.rejectUnauthorized = false`, and `disable` and
 * `no-verify` turn TLS off — and `require` is exactly what many managed
 * PostgreSQL providers put in the connection string they hand out. Allowing it
 * through would silently accept an unverified connection, so those values are
 * refused instead. `verify-full` is the one mode that keeps verification on.
 */
const ALLOWED_SSL_MODE = "verify-full";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Whether the test database must be reached through the discrete variables.
 *
 * Test runs are isolated by `assertTestDatabaseEnvironment()`, which pins
 * `DATABASE_NAME` to the test database and which the discrete `DATABASE_*`
 * variables feed into. Honouring `DATABASE_URL` here would route the test
 * runner, the migration script and the pool at a different database entirely
 * and bypass that isolation, so `DATABASE_URL` is ignored under `NODE_ENV=test`.
 */
export function isTestEnvironment(env: DatabaseEnv): boolean {
  return env.NODE_ENV === "test";
}

export function resolveDatabaseSource(env: DatabaseEnv): DatabaseSource {
  if (isTestEnvironment(env)) {
    return "discrete-test-isolation";
  }
  return readOptional(env, "DATABASE_URL") === undefined
    ? "discrete"
    : "connection-string";
}

function readOptional(env: DatabaseEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireEnv(env: DatabaseEnv, name: string): string {
  const value = readOptional(env, name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireInteger(
  env: DatabaseEnv,
  name: string,
  minimum: number,
  maximum: number
): number {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return parseInteger(raw, name, minimum, maximum);
}

function optionalInteger(
  env: DatabaseEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  return parseInteger(raw, name, minimum, maximum);
}

function parseInteger(
  raw: string,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid value for ${name}: expected an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function requireBoolean(
  env: DatabaseEnv,
  name: string,
  fallback: boolean
): boolean {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  return parseBoolean(raw, name);
}

function parseBoolean(raw: string, name: string): boolean {
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

function isProduction(env: DatabaseEnv): boolean {
  return env.NODE_ENV === "production";
}

/**
 * TLS is on by default for a `DATABASE_URL` and off for the discrete
 * variables, which is what local development has always used. The one rule
 * that matters: production can never have TLS explicitly switched off.
 *
 * The production guard is deliberately on the explicit value only. Refusing the
 * per-source default instead would make the discrete variables unusable in
 * production, even though the operator never asked to weaken anything. Choosing
 * the discrete variables is itself the decision to connect without TLS.
 */
export function resolveSslEnabled(
  env: DatabaseEnv,
  usingConnectionString: boolean
): boolean {
  const raw = readOptional(env, "DATABASE_SSL");
  if (raw === undefined) {
    return usingConnectionString;
  }

  const enabled = parseBoolean(raw, "DATABASE_SSL");
  if (!enabled && isProduction(env)) {
    throw new Error(
      "DATABASE_SSL=false is not allowed when NODE_ENV=production."
    );
  }
  return enabled;
}

/**
 * Validates the parts of a `DATABASE_URL` this application depends on and
 * refuses an `sslmode` that would weaken verification. The URL is never
 * included in an error, because it carries the password.
 */
export function parseConnectionString(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "Invalid DATABASE_URL: expected a postgres:// or postgresql:// connection string."
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `Invalid DATABASE_URL: expected a postgres:// or postgresql:// scheme.`
    );
  }

  if (url.hostname === "") {
    throw new Error("Invalid DATABASE_URL: no database host was given.");
  }

  if (url.pathname === "" || url.pathname === "/") {
    throw new Error("Invalid DATABASE_URL: no database name was given.");
  }

  const sslMode = url.searchParams.get("sslmode");
  if (sslMode !== null && sslMode.toLowerCase() !== ALLOWED_SSL_MODE) {
    throw new Error(
      `Refusing sslmode="${sslMode}" in DATABASE_URL: this application requires the ` +
        `server certificate and hostname to be verified. Remove the sslmode parameter, ` +
        `or set sslmode=${ALLOWED_SSL_MODE}.`
    );
  }

  return url;
}

/**
 * Builds the options `pg` connects with.
 *
 * Local development is untouched: the five discrete variables produce exactly
 * the object `config/env` has always produced, and no `ssl` key is added unless
 * TLS was actually requested, so `pg` keeps applying its own default (and any
 * `PGSSLMODE` the developer already relies on).
 */
export function resolveDatabaseConfig(env: DatabaseEnv): PoolConfig {
  const connectionString = readOptional(env, "DATABASE_URL");

  if (connectionString !== undefined && !isTestEnvironment(env)) {
    parseConnectionString(connectionString);
    const ssl = resolveSslEnabled(env, true) ? { rejectUnauthorized: true } : undefined;
    return {
      connectionString,
      ...(ssl ? { ssl } : {}),
    };
  }

  const config: PoolConfig = {
    host: requireEnv(env, "DATABASE_HOST"),
    port: requireInteger(env, "DATABASE_PORT", 1, 65535),
    database: requireEnv(env, "DATABASE_NAME"),
    user: requireEnv(env, "DATABASE_USER"),
    password: requireEnv(env, "DATABASE_PASSWORD"),
  };

  const ssl = resolveSslEnabled(env, false) ? { rejectUnauthorized: true } : undefined;
  return ssl ? { ...config, ssl } : config;
}

/**
 * Explicit pool sizing instead of `pg`'s defaults, because the right values
 * depend on how many application instances can run at once. Every setting is
 * overridable per environment; none of the defaults are provider-specific.
 */
export function resolvePoolSettings(env: DatabaseEnv): PoolSettings {
  const usingConnectionString = resolveDatabaseSource(env) === "connection-string";

  return {
    max: optionalInteger(
      env,
      "DATABASE_POOL_MAX",
      usingConnectionString
        ? DATABASE_POOL_DEFAULTS.connectionStringMax
        : DATABASE_POOL_DEFAULTS.discreteMax,
      1,
      POOL_MAX_LIMIT
    ),
    connectionTimeoutMillis: optionalInteger(
      env,
      "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      DATABASE_POOL_DEFAULTS.connectionTimeoutMillis,
      1,
      CONNECTION_TIMEOUT_LIMIT
    ),
    idleTimeoutMillis: optionalInteger(
      env,
      "DATABASE_POOL_IDLE_TIMEOUT_MS",
      DATABASE_POOL_DEFAULTS.idleTimeoutMillis,
      0,
      IDLE_TIMEOUT_LIMIT
    ),
    allowExitOnIdle: requireBoolean(
      env,
      "DATABASE_POOL_ALLOW_EXIT_ON_IDLE",
      usingConnectionString
    ),
  };
}
