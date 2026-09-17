import { promises as fs } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(__dirname, "..", "..", ".playwright-locks");
const LOCK_FILE = join(LOCK_DIR, "attendance-fixtures.lock");
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
 * Serializes E2E specs that share the live attendance fixtures.
 *
 * The lecturer spec deliberately starts active E2E-101 sessions that the
 * student is enrolled in, and the student spec reads the real eligible-session
 * endpoint. If those specs overlap in parallel workers, the student briefly
 * sees the lecturer's transient session as an extra "Mark attendance" action.
 * Holding this lock for the duration of each spec keeps the shared DB state
 * consistent without relaxing any assertions. The admin attendance-reports
 * spec also participates because it reads real E2E-101 counts.
 *
 * The caller receives a release function bound to the exact token this
 * acquisition wrote, so concurrent or sequential acquisitions in the same
 * worker can never interfere with each other through shared module state.
 */
export async function acquireAttendanceFixturesLock(): Promise<
  () => Promise<void>
> {
  await ensureLockDir();
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(LOCK_FILE, token, { flag: "wx" });
      return async (): Promise<void> => {
        try {
          const current = await fs.readFile(LOCK_FILE, "utf8");
          if (current === token) {
            await fs.unlink(LOCK_FILE);
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
        const stat = await fs.stat(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(LOCK_FILE);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
  throw new Error(
    `Could not acquire attendance fixtures mutex after ${MAX_ATTEMPTS} attempts. ` +
      `Stale lock files under ${LOCK_DIR} may need manual removal.`
  );
}