// Removes course-management E2E test data (courses created with the E2EMGMT
// prefix by admin-course-management.spec.ts) along with their offerings and
// lecturer assignments, so the E2E faculty/department/lecturer seed rows can
// be removed cleanly afterwards.
// Runs as a plain Node script so it can reuse the backend's pg and dotenv
// modules without adding code to the backend.
"use strict";

const path = require("node:path");

const backendDir = path.join(__dirname, "..", "..", "..", "backend");
const nodeModules = path.join(backendDir, "node_modules");

const dotenv = require(path.join(nodeModules, "dotenv"));
dotenv.config({ path: path.join(backendDir, ".env"), override: false });

const testDatabaseName = process.env.TEST_DATABASE_NAME ?? "oou_attendance_test";
if (
  process.env.NODE_ENV !== "test" ||
  process.env.DATABASE_NAME !== testDatabaseName ||
  !/^oou_attendance_test(?:_[a-z0-9]+)*$/.test(testDatabaseName)
) {
  throw new Error(
    `Refusing course-management cleanup: expected test database "${testDatabaseName}".`
  );
}

const { Client } = require(path.join(nodeModules, "pg"));

const E2E_COURSE_CODE_PREFIX = "E2EMGMT";

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
    const identity = await client.query(
      "SELECT current_database() AS database_name"
    );
    const actualDatabaseName = identity.rows[0]?.database_name;
    if (actualDatabaseName !== testDatabaseName) {
      throw new Error(
        `Refusing course-management cleanup: connected to "${actualDatabaseName}".`
      );
    }
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM attendance_records
       WHERE session_id IN (
         SELECT id FROM attendance_sessions
         WHERE course_offering_id IN (
           SELECT id FROM course_offerings
           WHERE course_id IN (
             SELECT id FROM courses WHERE course_code LIKE $1
           )
         )
       )`,
      [`${E2E_COURSE_CODE_PREFIX}%`]
    );
    await client.query(
      `DELETE FROM attendance_sessions
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (
           SELECT id FROM courses WHERE course_code LIKE $1
         )
       )`,
      [`${E2E_COURSE_CODE_PREFIX}%`]
    );
    await client.query(
      `DELETE FROM course_offering_lecturers
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (
           SELECT id FROM courses WHERE course_code LIKE $1
         )
       )`,
      [`${E2E_COURSE_CODE_PREFIX}%`]
    );
    await client.query(
      `DELETE FROM course_registrations
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (
           SELECT id FROM courses WHERE course_code LIKE $1
         )
       )`,
      [`${E2E_COURSE_CODE_PREFIX}%`]
    );
    await client.query(
      `DELETE FROM course_offerings
       WHERE course_id IN (
         SELECT id FROM courses WHERE course_code LIKE $1
       )`,
      [`${E2E_COURSE_CODE_PREFIX}%`]
    );
    await client.query("DELETE FROM courses WHERE course_code LIKE $1", [
      `${E2E_COURSE_CODE_PREFIX}%`,
    ]);
    await client.query("COMMIT");
    console.log("Cleaned up course-management E2E data.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Course-management cleanup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Course-management cleanup failed:", error.message);
  process.exit(1);
});