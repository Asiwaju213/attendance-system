import { execSync } from "node:child_process";
import { join } from "node:path";
import { testEnvironment } from "./test-environment";

const backendDir = join(__dirname, "..", "..", "backend");
const testEnv = testEnvironment();

export default function globalSetup(): void {
  // Remove any course-management E2E data a previous run left behind (a
  // crashed run can skip global teardown). This must happen before seeding:
  // the seed job deletes the shared E2E faculty/department/lecturers, which is
  // blocked while E2EMGMT courses still reference them.
  try {
    execSync("node ../tests/e2e/helpers/cleanup-course-management.cjs", {
      cwd: backendDir,
      env: testEnv,
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (error) {
    console.warn("Failed to clean up course-management E2E data:", (error as Error).message);
  }

  execSync("npm run seed:e2e", {
    cwd: backendDir,
    env: testEnv,
    stdio: "inherit",
    timeout: 120_000,
  });
}