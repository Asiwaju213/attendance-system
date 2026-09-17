import { execSync } from "node:child_process";
import { join } from "node:path";

const backendDir = join(__dirname, "..", "..", "backend");

export default function globalTeardown(): void {
  try {
    execSync("npm run unseed:e2e", {
      cwd: backendDir,
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch (error) {
    console.warn("Failed to clean up E2E users:", (error as Error).message);
  }

  // Clean up academic-period test data created by admin-academic-periods.spec.ts
  try {
    execSync("node", [
      join(__dirname, "helpers", "cleanup-academic-periods.cjs"),
    ], {
      cwd: backendDir,
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (error) {
    console.warn("Failed to clean up academic-period E2E data:", (error as Error).message);
  }
}