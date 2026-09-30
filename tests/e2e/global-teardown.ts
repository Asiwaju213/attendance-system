import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { testEnvironment } from "./test-environment";

const backendDir = join(__dirname, "..", "..", "backend");
const testEnv = testEnvironment();

export default function globalTeardown(): void {
  // Remove course-management E2E data FIRST: it references the shared E2E
  // faculty/department/lecturers, so unwinding it before `unseed:e2e` lets the
  // seed cleanup delete those rows without being blocked by RESTRICT FKs.
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

  try {
    execSync("npm run unseed:e2e", {
      cwd: backendDir,
      env: testEnv,
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch (error) {
    console.warn("Failed to clean up E2E users:", (error as Error).message);
  }

  // Clean up academic-period test data created by admin-academic-periods.spec.ts
  try {
    execFileSync(
      "node",
      [join(__dirname, "helpers", "cleanup-academic-periods.cjs")],
      {
        cwd: backendDir,
        env: testEnv,
        stdio: "inherit",
        timeout: 60_000,
      }
    );
  } catch (error) {
    console.warn("Failed to clean up academic-period E2E data:", (error as Error).message);
  }
}