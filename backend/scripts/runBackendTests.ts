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
        // STUDENT_ACCESS_MODE=edge for the child processes, because the default app instance the
        // suites import must be the K12 edge: the student-facing suites (device login,
        // enrollment, attendance, registration) describe that deployment, and with the
        // fail-closed `cloud` default they could not mint a student session at all.
        //
        // The WebAuthn RP identity is pinned for the same reason: the suites drive real
        // registration/assertion ceremonies through @simplewebauthn/server, and the local
        // development origin (http://localhost:4173 with RP id "localhost") is the one the
        // project supports out of the box. A developer's .env WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN for
        // their LAN or TLS setup must not leak into the tests, whose assertions hard-code the
        // development origin. Production WebAuthn configuration is left untouched.
        //
        // Both are set here rather than left to backend/.env so the suites behave the same on
        // every machine - dotenv does not overwrite an existing value - and so a developer's
        // local .env cannot change what the tests exercise. Cloud-mode behaviour is asserted
        // explicitly in tests/studentAccessPolicy.test.ts, which builds its own apps in both
        // modes. DOTENV_CONFIG_* is deliberately not used: the config modules read these values
        // at import time, and the pinned child environment is the single deterministic source.
        env: {
          ...process.env,
          STUDENT_ACCESS_MODE: "edge",
          WEBAUTHN_RP_ID: "localhost",
          WEBAUTHN_ORIGIN: "http://localhost:4173",
        },
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
