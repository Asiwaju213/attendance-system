import { promises as fs } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(__dirname, "..", "..", ".playwright-locks");
const LOCK_STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 7_200;

async function ensureLockDir(): Promise<void> {
  try {
    await fs.mkdir(LOCK_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Generic mutex for coordinating access to a named lock file.
 */
async function acquireNamedLock(
  lockName: string
): Promise<() => Promise<void>> {
  await ensureLockDir();
  const lockFile = join(LOCK_DIR, `${lockName}.lock`);
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(lockFile, token, { flag: "wx" });
      return async (): Promise<void> => {
        try {
          const current = await fs.readFile(lockFile, "utf8");
          if (current === token) {
            await fs.unlink(lockFile);
          }
        } catch {
          // Lock already released or does not exist.
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
  throw new Error(
    `Could not acquire ${lockName} mutex after ${MAX_ATTEMPTS} attempts. ` +
      `Stale lock files under ${LOCK_DIR} may need manual removal.`
  );
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