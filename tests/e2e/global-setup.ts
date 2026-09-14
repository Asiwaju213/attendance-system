import { execSync } from "node:child_process";
import { join } from "node:path";

const backendDir = join(__dirname, "..", "..", "backend");

export default function globalSetup(): void {
  execSync("npm run seed:e2e", {
    cwd: backendDir,
    stdio: "inherit",
    timeout: 120_000,
  });
}