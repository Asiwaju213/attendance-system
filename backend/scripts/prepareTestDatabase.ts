import { join } from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";
import {
  configureTestDatabase,
  getTestDatabaseName,
} from "../src/config/testDatabase";

const backendDir = join(__dirname, "..");
const envPath = join(backendDir, ".env");

dotenv.config({ path: envPath, override: false, quiet: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requirePort(): number {
  const value = requireEnv("DATABASE_PORT");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid value for DATABASE_PORT: "${value}"`);
  }
  return port;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe database identifier: "${identifier}".`);
  }
  return `"${identifier}"`;
}

async function databaseExists(client: Client, databaseName: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [databaseName]
  );
  return result.rows.length > 0;
}

export async function prepareTestDatabase(): Promise<void> {
  configureTestDatabase();
  const databaseName = getTestDatabaseName();
  const maintenanceDatabase =
    process.env.DATABASE_MAINTENANCE_NAME ?? "postgres";

  if (maintenanceDatabase === databaseName) {
    throw new Error(
      "DATABASE_MAINTENANCE_NAME must not be the test database."
    );
  }

  const connectionConfig = {
    host: requireEnv("DATABASE_HOST"),
    port: requirePort(),
    user: requireEnv("DATABASE_USER"),
    password: requireEnv("DATABASE_PASSWORD"),
  };

  const adminClient = new Client({
    ...connectionConfig,
    database: maintenanceDatabase,
  });

  await adminClient.connect();
  try {
    if (!(await databaseExists(adminClient, databaseName))) {
      try {
        await adminClient.query(
          `CREATE DATABASE ${quoteIdentifier(databaseName)}`
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "42P04") {
          throw error;
        }
      }
    }

    if (!(await databaseExists(adminClient, databaseName))) {
      throw new Error(`Test database was not created: "${databaseName}".`);
    }
  } finally {
    await adminClient.end();
  }

  const testClient = new Client({
    ...connectionConfig,
    database: databaseName,
  });
  await testClient.connect();
  try {
    const identity = await testClient.query(
      "SELECT current_database() AS database_name"
    );
    const actualDatabaseName = identity.rows[0]?.database_name;
    if (actualDatabaseName !== databaseName) {
      throw new Error(
        `Refusing test database setup: connected to "${actualDatabaseName}".`
      );
    }
    console.log(`Test database ready: ${databaseName}.`);
  } finally {
    await testClient.end();
  }
}

if (require.main === module) {
  prepareTestDatabase().catch((error) => {
    console.error("Test database setup failed:", (error as Error).message);
    process.exit(1);
  });
}
