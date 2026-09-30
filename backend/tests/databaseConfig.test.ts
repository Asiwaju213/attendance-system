import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_POOL_DEFAULTS,
  isTestEnvironment,
  parseConnectionString,
  resolveDatabaseConfig,
  resolveDatabaseSource,
  resolvePoolSettings,
  resolveSslEnabled,
} from "../src/config/database";

/**
 * The database connection is configured two ways: the five discrete
 * `DATABASE_*` variables local development has always used, and a single
 * `DATABASE_URL` for a managed/cloud database.
 *
 * Three things have to stay true. Local development must keep working exactly
 * as before, with no new required variable. The `DATABASE_URL` path must not be
 * able to weaken TLS, because `pg` lets the connection string override the
 * options passed to it. And the test database must remain unreachable through
 * `DATABASE_URL`, or the isolation guard in `config/testDatabase` would be
 * bypassed.
 */

const LOCAL_ENV = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "oou_attendance",
  DATABASE_USER: "oou_app",
  DATABASE_PASSWORD: "local-development-password",
};

const CLOUD_URL =
  "postgres://cloud_user:cloud_password@db.example.com:5432/oou_attendance?sslmode=verify-full";

const CLOUD_ENV = { DATABASE_URL: CLOUD_URL, NODE_ENV: "production" };

test("A. the discrete variables alone still build the local connection unchanged", () => {
  assert.deepEqual(resolveDatabaseConfig(LOCAL_ENV), {
    host: "127.0.0.1",
    port: 5432,
    database: "oou_attendance",
    user: "oou_app",
    password: "local-development-password",
  });
  assert.equal(resolveDatabaseSource(LOCAL_ENV), "discrete");
});

test("A. local development needs no DATABASE_URL and no new variable", () => {
  // Exactly the variables the project already required, and nothing else.
  assert.deepEqual(Object.keys(LOCAL_ENV).sort(), [
    "DATABASE_HOST",
    "DATABASE_NAME",
    "DATABASE_PASSWORD",
    "DATABASE_PORT",
    "DATABASE_USER",
  ]);
  assert.doesNotThrow(() => resolveDatabaseConfig({ ...LOCAL_ENV, NODE_ENV: "development" }));
});

test("A. the local path adds no ssl key, leaving pg's existing default in place", () => {
  const config = resolveDatabaseConfig(LOCAL_ENV);
  assert.equal("ssl" in config, false);
  assert.equal("connectionString" in config, false);
});

test("B. DATABASE_URL is used as the connection when it is set", () => {
  const config = resolveDatabaseConfig(CLOUD_ENV);

  assert.equal(config.connectionString, CLOUD_URL);
  assert.equal("host" in config, false);
  assert.equal("database" in config, false);
  assert.equal("password" in config, false);
  assert.equal(resolveDatabaseSource(CLOUD_ENV), "connection-string");
});

test("B. a URL without a port or query still resolves", () => {
  const config = resolveDatabaseConfig({
    DATABASE_URL: "postgresql://user:pass@db.example.com/oou_attendance",
    NODE_ENV: "production",
  });

  assert.equal(config.connectionString, "postgresql://user:pass@db.example.com/oou_attendance");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("C. DATABASE_URL wins when both forms are present", () => {
  const config = resolveDatabaseConfig({ ...LOCAL_ENV, ...CLOUD_ENV });

  assert.equal(config.connectionString, CLOUD_URL);
  assert.equal(resolveDatabaseSource({ ...LOCAL_ENV, ...CLOUD_ENV }), "connection-string");
  assert.equal("host" in config, false);
  assert.equal("user" in config, false);
});

test("C. a blank DATABASE_URL is treated as unset, so local keeps working", () => {
  for (const blank of ["", "   "]) {
    const env = { ...LOCAL_ENV, DATABASE_URL: blank };
    assert.equal(resolveDatabaseSource(env), "discrete", `expected "${blank}" to be unset`);
    assert.equal("connectionString" in resolveDatabaseConfig(env), false);
  }
});

test("D. the cloud connection verifies the server certificate", () => {
  assert.deepEqual(resolveDatabaseConfig(CLOUD_ENV).ssl, { rejectUnauthorized: true });
  assert.deepEqual(
    resolveDatabaseConfig({ DATABASE_URL: CLOUD_URL }).ssl,
    { rejectUnauthorized: true }
  );
});

test("D. certificate verification is never switched off by this application", () => {
  const environments = [
    LOCAL_ENV,
    CLOUD_ENV,
    { ...CLOUD_ENV, DATABASE_SSL: "true" },
    { ...LOCAL_ENV, NODE_ENV: "production" },
  ];

  for (const env of environments) {
    const config = resolveDatabaseConfig(env as Record<string, string>);
    const serialised = JSON.stringify(config.ssl ?? null);
    assert.doesNotMatch(
      serialised,
      /"rejectUnauthorized":false/,
      `expected no disabled verification in ${serialised}`
    );
  }
});

test("D. an sslmode that would weaken verification is refused", () => {
  // These are the values `pg-connection-string` would otherwise turn into
  // `ssl.rejectUnauthorized = false` or `ssl = false`, and `require`/`prefer`
  // are what most managed providers put in the URL they hand out.
  for (const mode of ["require", "prefer", "disable", "no-verify", "verify-ca", "allow"]) {
    const url = `postgres://user:pass@db.example.com:5432/oou?sslmode=${mode}`;
    assert.throws(
      () => parseConnectionString(url),
      /Refusing sslmode=/,
      `expected sslmode=${mode} to be refused`
    );
    assert.throws(
      () => resolveDatabaseConfig({ DATABASE_URL: url, NODE_ENV: "production" }),
      new RegExp(`Refusing sslmode="${mode}"`)
    );
  }
});

test("D. sslmode=verify-full and an absent sslmode are both accepted", () => {
  assert.equal(parseConnectionString(CLOUD_URL).searchParams.get("sslmode"), "verify-full");
  assert.doesNotThrow(() =>
    parseConnectionString("postgres://user:pass@db.example.com:5432/oou")
  );
  assert.doesNotThrow(() =>
    parseConnectionString("postgres://user:pass@db.example.com:5432/oou?sslmode=VERIFY-FULL")
  );
});

test("D. DATABASE_SSL defaults on for a URL and off for the discrete variables", () => {
  assert.equal(resolveSslEnabled({ NODE_ENV: "production" }, true), true);
  assert.equal(resolveSslEnabled({ NODE_ENV: "production" }, false), false);
  assert.equal(resolveSslEnabled({ NODE_ENV: "development" }, true), true);
  assert.equal(resolveSslEnabled({ NODE_ENV: "development" }, false), false);
});

test("D. TLS can be requested for a local database that is configured to use it", () => {
  const config = resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_SSL: "true" });

  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.host, "127.0.0.1");
});

test("E. pool defaults keep the local pool size and use one connection per instance in the cloud", () => {
  assert.deepEqual(resolvePoolSettings(LOCAL_ENV), {
    max: DATABASE_POOL_DEFAULTS.discreteMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });

  assert.deepEqual(resolvePoolSettings(CLOUD_ENV), {
    max: DATABASE_POOL_DEFAULTS.connectionStringMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
});

test("E. the local default max is the value pg has always used", () => {
  assert.equal(DATABASE_POOL_DEFAULTS.discreteMax, 10);
});

test("E. every pool setting is overridable by environment variable", () => {
  const settings = resolvePoolSettings({
    ...CLOUD_ENV,
    DATABASE_POOL_MAX: "5",
    DATABASE_POOL_CONNECTION_TIMEOUT_MS: "2500",
    DATABASE_POOL_IDLE_TIMEOUT_MS: "90000",
    DATABASE_POOL_ALLOW_EXIT_ON_IDLE: "false",
  });

  assert.deepEqual(settings, {
    max: 5,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 90_000,
    allowExitOnIdle: false,
  });
});

test("E. the pool settings are exactly the four documented options", () => {
  assert.deepEqual(Object.keys(resolvePoolSettings(CLOUD_ENV)).sort(), [
    "allowExitOnIdle",
    "connectionTimeoutMillis",
    "idleTimeoutMillis",
    "max",
  ]);
});

test("E. boolean pool and TLS settings are read leniently for case and spacing", () => {
  for (const raw of ["TRUE", "  yes  ", "On", "1"]) {
    assert.equal(
      resolveSslEnabled({ DATABASE_SSL: raw, NODE_ENV: "production" }, false),
      true,
      `expected DATABASE_SSL="${raw}" to be read as true`
    );
  }
  for (const raw of ["FALSE", "  no  ", "Off", "0"]) {
    assert.equal(
      resolveSslEnabled({ DATABASE_SSL: raw, NODE_ENV: "development" }, false),
      false,
      `expected DATABASE_SSL="${raw}" to be read as false`
    );
  }
});

test("F. a missing discrete variable fails with the existing clear message", () => {
  assert.throws(
    () => resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_HOST: undefined }),
    /Missing required environment variable: DATABASE_HOST/
  );
  assert.throws(
    () => resolveDatabaseConfig({ DATABASE_HOST: "127.0.0.1" }),
    /Missing required environment variable: DATABASE_PORT/
  );
});

test("F. an invalid port is rejected rather than silently defaulted", () => {
  for (const port of ["0", "70000", "-1", "abc", "5432.5"]) {
    assert.throws(
      () => resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_PORT: port }),
      /Invalid value for DATABASE_PORT/,
      `expected DATABASE_PORT="${port}" to be rejected`
    );
  }
  // Blank is treated as absent, and an absent port must not become NaN.
  for (const port of ["", "   "]) {
    assert.throws(
      () => resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_PORT: port }),
      /Missing required environment variable: DATABASE_PORT/
    );
  }
});

test("F. an unrecognised boolean fails at startup instead of being ignored", () => {
  assert.throws(
    () => resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_SSL: "maybe" }),
    /Invalid value for DATABASE_SSL/
  );
  assert.throws(
    () => resolvePoolSettings({ ...LOCAL_ENV, DATABASE_POOL_ALLOW_EXIT_ON_IDLE: "maybe" }),
    /Invalid value for DATABASE_POOL_ALLOW_EXIT_ON_IDLE/
  );
});

test("F. an out-of-range pool setting is rejected", () => {
  assert.throws(
    () => resolvePoolSettings({ ...LOCAL_ENV, DATABASE_POOL_MAX: "0" }),
    /Invalid value for DATABASE_POOL_MAX/
  );
  assert.throws(
    () => resolvePoolSettings({ ...LOCAL_ENV, DATABASE_POOL_MAX: "500" }),
    /Invalid value for DATABASE_POOL_MAX/
  );
  assert.throws(
    () => resolvePoolSettings({ ...LOCAL_ENV, DATABASE_POOL_CONNECTION_TIMEOUT_MS: "nope" }),
    /Invalid value for DATABASE_POOL_CONNECTION_TIMEOUT_MS/
  );
});

test("F. an unusable connection string is rejected with a clear message", () => {
  for (const url of ["", "not-a-url", "http://db.example.com/oou", "mysql://u:p@h:5432/d"]) {
    assert.throws(
      () => parseConnectionString(url),
      /Invalid DATABASE_URL/,
      `expected "${url}" to be rejected`
    );
  }

  assert.throws(
    () => parseConnectionString("postgres:///oou"),
    /no database host/
  );
  assert.throws(
    () => parseConnectionString("postgres://user:pass@db.example.com:5432"),
    /no database name/
  );
});

test("G. production can never be configured without TLS", () => {
  for (const raw of ["false", "0", "no", "off", "FALSE", "  false  "]) {
    assert.throws(
      () => resolveSslEnabled({ NODE_ENV: "production", DATABASE_SSL: raw }, true),
      /DATABASE_SSL=false is not allowed when NODE_ENV=production/,
      `expected DATABASE_SSL="${raw}" to be refused in production`
    );
  }
});

test("G. a production URL always resolves to a verifying connection", () => {
  const config = resolveDatabaseConfig({
    DATABASE_URL: "postgres://user:pass@db.example.com:5432/oou",
    NODE_ENV: "production",
  });

  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.deepEqual(resolvePoolSettings({ ...LOCAL_ENV, NODE_ENV: "production" }).allowExitOnIdle, false);
});

test("G. production still works through the discrete variables without DATABASE_URL", () => {
  const config = resolveDatabaseConfig({ ...LOCAL_ENV, NODE_ENV: "production" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal("connectionString" in config, false);
});

test("G. production with no database configuration at all fails rather than defaulting", () => {
  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: "production" }),
    /Missing required environment variable: DATABASE_HOST/
  );
});

test("test isolation is authoritative: DATABASE_URL is ignored under NODE_ENV=test", () => {
  const testEnv = {
    ...LOCAL_ENV,
    ...CLOUD_ENV,
    NODE_ENV: "test",
    TEST_DATABASE_NAME: "oou_attendance_test",
    DATABASE_NAME: "oou_attendance_test",
  };

  assert.equal(isTestEnvironment(testEnv), true);
  assert.equal(resolveDatabaseSource(testEnv), "discrete-test-isolation");

  const config = resolveDatabaseConfig(testEnv);
  assert.equal("connectionString" in config, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.database, "oou_attendance_test");

  // The pool sizing follows the isolated path, not the cloud path.
  assert.equal(resolvePoolSettings(testEnv).max, DATABASE_POOL_DEFAULTS.discreteMax);
});

test("secrets never appear in a configuration error", () => {
  const secret = "hunter2-do-not-log";
  const urls = [
    `postgres://app:${secret}@db.example.com:5432/oou?sslmode=require`,
    `not-a-url-with-${secret}`,
    `postgres://app:${secret}@:5432/oou`,
    `postgres://app:${secret}@db.example.com:5432`,
    `http://app:${secret}@db.example.com/oou`,
  ];

  for (const url of urls) {
    let message = "";
    try {
      parseConnectionString(url);
    } catch (error) {
      message = (error as Error).message;
    }
    assert.notEqual(message, "", `expected "${url}" to be rejected`);
    assert.doesNotMatch(
      message,
      new RegExp(secret),
      `error message leaked the password: ${message}`
    );
  }

  // The discrete path reports the missing variable, not its value.
  assert.throws(
    () => resolveDatabaseConfig({ ...LOCAL_ENV, DATABASE_HOST: undefined }),
    (error: Error) => !error.message.includes(LOCAL_ENV.DATABASE_PASSWORD)
  );
});
