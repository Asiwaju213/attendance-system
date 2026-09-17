// Removes academically-scoped E2E test data (academic sessions created by the
// academic-periods spec) and restores the seeded session as the active one.
// Runs as a plain Node script so it can reuse the backend's pg and dotenv
// modules without adding code to the backend.
"use strict";

const path = require("node:path");

const backendDir = path.join(__dirname, "..", "..", "..", "backend");
const nodeModules = path.join(backendDir, "node_modules");

const dotenv = require(path.join(nodeModules, "dotenv"));
dotenv.config({ path: path.join(backendDir, ".env"), override: true });

const { Client } = require(path.join(nodeModules, "pg"));

const E2E_SESSION_PREFIX = "E2E-AP";
const SEEDED_SESSION_NAME = "E2E-2026/2027";

async function main() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM academic_sessions WHERE name LIKE $1", [
      `${E2E_SESSION_PREFIX}%`,
    ]);
    await client.query(
      "UPDATE academic_sessions SET is_active = false WHERE is_active = true AND name LIKE $1",
      [`${E2E_SESSION_PREFIX}%`]
    );
    await client.query(
      "UPDATE academic_sessions SET is_active = true WHERE name = $1",
      [SEEDED_SESSION_NAME]
    );
    await client.query("COMMIT");
    console.log("Cleaned up academic-period E2E data.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Academic-period cleanup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Academic-period cleanup failed:", error.message);
  process.exit(1);
});