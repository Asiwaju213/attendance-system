import { join } from "node:path";
import { spawn } from "node:child_process";
import { configureTestDatabase } from "../src/config/testDatabase";

const backendDir = join(__dirname, "..");

function runSeed(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        join(backendDir, "scripts", "seedE2EUsers.ts"),
        ...process.argv.slice(2),
      ],
      {
        cwd: backendDir,
        env: { ...process.env },
        stdio: "inherit",
      }
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`E2E seed runner terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  configureTestDatabase();
  process.exitCode = await runSeed();
}

main().catch((error) => {
  console.error("E2E seed runner failed:", (error as Error).message);
  process.exitCode = 1;
});
