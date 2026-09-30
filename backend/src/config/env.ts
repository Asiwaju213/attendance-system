import type { PoolConfig } from "pg";
import dotenv from "dotenv";
import { assertTestDatabaseEnvironment } from "./testDatabase";
import {
  isTestEnvironment,
  resolveDatabaseConfig,
  resolveDatabaseSource,
  resolvePoolSettings,
  type DatabaseSource,
  type PoolSettings,
} from "./database";

dotenv.config();

if (process.env.NODE_ENV === "test") {
  assertTestDatabaseEnvironment();
}

if (isTestEnvironment(process.env) && process.env.DATABASE_URL?.trim()) {
  // The test database is reached through the discrete variables, which the
  // isolation guard above checks. Say so rather than quietly ignoring the URL.
  console.warn(
    "Ignoring DATABASE_URL because NODE_ENV=test; the test database is always reached through the discrete DATABASE_* variables."
  );
}

/**
 * Which form of database configuration is in use. Logged at startup and
 * deliberately free of any host, database name or credential.
 */
export const databaseSource: DatabaseSource = resolveDatabaseSource(process.env);

export const dbConfig: PoolConfig = resolveDatabaseConfig(process.env);

export const dbPoolSettings: PoolSettings = resolvePoolSettings(process.env);
