import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configureTestDatabase } from "../src/config/testDatabase";
import { prepareTestDatabase } from "./prepareTestDatabase";

const backendDir = join(__dirname, "..");

function runTsx(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve("tsx/cli"), ...args],
      {
        cwd: backendDir,
        env: { ...process.env },
        stdio: "inherit",
      }
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Test runner terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function runE2ESeed(cleanupOnly: boolean): Promise<number> {
  const args = [join("scripts", "seedE2EUsers.ts")];
  if (cleanupOnly) {
    args.push("--cleanup");
  }
  return runTsx(args);
}

async function main(): Promise<void> {
  configureTestDatabase();
  await prepareTestDatabase();

  const { runMigrations } = await import("./runMigrations");
  await runMigrations();

  const testFiles = readdirSync(join(backendDir, "tests"))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => join("tests", file));

  if (testFiles.length === 0) {
    throw new Error("No backend test files were found.");
  }

  let testExitCode = 1;
  try {
    const seedExitCode = await runE2ESeed(false);
    if (seedExitCode !== 0) {
      testExitCode = seedExitCode;
    } else {
      testExitCode = await runTsx([
        "--test",
        "--test-concurrency=1",
        ...testFiles,
      ]);
    }
  } finally {
    const cleanupExitCode = await runE2ESeed(true);
    if (testExitCode === 0 && cleanupExitCode !== 0) {
      testExitCode = cleanupExitCode;
    }
  }

  process.exitCode = testExitCode;
}

main().catch((error) => {
  console.error("Backend test runner failed:", (error as Error).message);
  process.exitCode = 1;
});
