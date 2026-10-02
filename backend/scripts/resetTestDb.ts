// Drops and recreates the disposable test database.
//
// `prepareTestDatabase` only creates the database when it is missing, so a suite
// that failed partway through leaves its rows behind and the next run collides on
// a unique code. This is the blunt instrument for that case: the test database is
// disposable by definition, so recreating it is always safe. It refuses to run
// unless the target name is recognisably a test database.
import { join } from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config({
  path: join(__dirname, "..", ".env"),
  override: false,
  quiet: true,
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe database identifier: "${identifier}".`);
  }
  return `"${identifier}"`;
}

(async () => {
  const databaseName =
    process.env.TEST_DATABASE_NAME ??
    process.env.DATABASE_NAME ??
    (() => {
      throw new Error(
        "Missing required environment variable: TEST_DATABASE_NAME"
      );
    })();
  const maintenanceDatabase = process.env.DATABASE_MAINTENANCE_NAME ?? "postgres";

  // Hard guard: this script destroys its target.
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to drop "${databaseName}": the name does not look like a test database.`
    );
  }
  if (maintenanceDatabase === databaseName) {
    throw new Error("DATABASE_MAINTENANCE_NAME must not be the test database.");
  }

  const connectionConfig = {
    host: requireEnv("DATABASE_HOST"),
    port: Number(requireEnv("DATABASE_PORT")),
    user: requireEnv("DATABASE_USER"),
    password: requireEnv("DATABASE_PASSWORD"),
  };

  const admin = new Client({ ...connectionConfig, database: maintenanceDatabase });
  await admin.connect();
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    console.log(`Recreated test database: ${databaseName}.`);
  } finally {
    await admin.end();
  }
})().catch((error) => {
  console.error("Test database reset failed:", (error as Error).message);
  process.exit(1);
});