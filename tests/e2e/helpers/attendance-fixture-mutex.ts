import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { testEnvironment } from "../test-environment";

const LOCK_DIR = join(__dirname, "..", "..", ".playwright-locks");
const LOCK_STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 7_200;
const MAX_TRANSIENT_EPERM_RETRIES = 5;
const RETRY_DELAY_MS = 25;
const backendDir = join(__dirname, "..", "..", "..", "backend");
const backendRequire = createRequire(join(backendDir, "package.json"));
const tsxCli = backendRequire.resolve("tsx/cli");

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function waitBeforeRetry(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, RETRY_DELAY_MS + Math.random() * RETRY_DELAY_MS)
  );
}

async function withTransientEppermRetry<T>(
  operation: () => Promise<T>
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        process.platform !== "win32" ||
        errorCode(error) !== "EPERM" ||
        retry >= MAX_TRANSIENT_EPERM_RETRIES
      ) {
        throw error;
      }
      await waitBeforeRetry();
    }
  }
}

/**
 * Generic mutex for coordinating access to a named lock file.
 */
async function acquireNamedLock(
  lockName: string
): Promise<() => Promise<void>> {
  await fs.mkdir(LOCK_DIR, { recursive: true });
  const lockFile = join(LOCK_DIR, `${lockName}.lock`);
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await withTransientEppermRetry(() =>
        fs.writeFile(lockFile, token, { flag: "wx" })
      );
      return async (): Promise<void> => {
        try {
          const current = await withTransientEppermRetry(() =>
            fs.readFile(lockFile, "utf8")
          );
          if (current === token) {
            await withTransientEppermRetry(() => fs.unlink(lockFile));
          }
        } catch (error: unknown) {
          if (errorCode(error) !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await withTransientEppermRetry(() => fs.stat(lockFile));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await withTransientEppermRetry(() => fs.unlink(lockFile));
          continue;
        }
      } catch (statError: unknown) {
        if (errorCode(statError) === "ENOENT") {
          continue;
        }
        throw statError;
      }
      await waitBeforeRetry();
    }
  }
  throw new Error(
    `Could not acquire ${lockName} mutex after ${MAX_ATTEMPTS} attempts. ` +
      `Stale lock files under ${LOCK_DIR} may need manual removal.`
  );
}

export function resetE2E102Registrations(): void {
  execFileSync(
    process.execPath,
    [
      tsxCli,
      join(backendDir, "scripts", "seedE2EUsers.ts"),
      "--reset-course-registrations=E2E-102",
    ],
    {
      cwd: backendDir,
      env: testEnvironment(),
      stdio: "pipe",
      timeout: 120_000,
    }
  );
}

export async function acquireE2E102RegistrationFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("e2e-102-registration-fixtures");
}

/**
 * Mutex for the lecturer↔student E2E-101 attendance fixtures.
 * The lecturer spec starts active E2E-101 sessions that the student spec reads.
 * If those specs overlap, the student briefly sees the lecturer's transient
 * session as an extra "Mark attendance" action.
 */
export async function acquireLecturerStudentFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("lecturer-student-fixtures");
}

/**
 * Mutex for admin monitoring E2E-101 sessions (monitor lecturer).
 * Reads sessions started by the monitor lecturer.
 */
export async function acquireAdminMonitoringFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("admin-monitoring-fixtures");
}

/**
 * Mutex for lecturer session report E2E-103 fixtures.
 * Reads a specific ended session for E2E-103.
 */
export async function acquireLecturerSessionReportFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("lecturer-session-report-fixtures");
}

/**
 * Mutex for admin attendance reports E2E-101 fixtures.
 * Reads real E2E-101 counts from the backend.
 */
export async function acquireAdminReportsFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("admin-reports-fixtures");
}

/**
 * Mutex for student attendance history E2E-101 fixtures.
 */
export async function acquireStudentHistoryFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("student-history-fixtures");
}

/**
 * Mutex for lecturer attendance reports E2E-102 fixtures (monitor's second offering).
 */
export async function acquireLecturerReportsFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("lecturer-reports-fixtures");
}

/**
 * @deprecated Use the specific fixture mutexes above.
 */
export async function acquireAttendanceFixturesLock(): Promise<
  () => Promise<void>
> {
  return acquireNamedLock("attendance-fixtures");
}