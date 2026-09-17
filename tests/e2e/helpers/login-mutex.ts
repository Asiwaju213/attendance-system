import { promises as fs } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(__dirname, "..", "..", ".playwright-locks");
const LOCK_FILE = join(LOCK_DIR, "login.lock");
const LOCK_STALE_MS = 60_000;
const MAX_ATTEMPTS = 2_400;

async function ensureLockDir(): Promise<void> {
  try {
    await fs.mkdir(LOCK_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function acquireLock(lockContent: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(LOCK_FILE, lockContent, { flag: "wx" });
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Lock is held. If the owner died (e.g. a previous `playwright test`
      // process was killed), the file is orphaned and must be reclaimed.
      try {
        const stat = await fs.stat(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(LOCK_FILE);
          continue;
        }
      } catch {
        continue; // Lock disappeared while statting; retry immediately.
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
  throw new Error(
    `Could not acquire login mutex after ${MAX_ATTEMPTS} attempts. ` +
      `Stale lock files under ${LOCK_DIR} may need manual removal.`
  );
}

async function releaseLock(lockContent: string): Promise<void> {
  try {
    const current = await fs.readFile(LOCK_FILE, "utf8");
    if (current === lockContent) {
      await fs.unlink(LOCK_FILE);
    }
  } catch {
    // Lock already released or does not exist.
  }
}

/**
 * Serializes the login POST across every Playwright worker and every role.
 *
 * Authentication deliberately runs an Argon2id password verification per
 * login (a production-side, memory-hard security measure). Argon2id is
 * CPU-bound and queues threads in a shared pool, so two workers logging in
 * at the same moment can slow each other enough to stall the redirect past a
 * test's URL assertion. This is a genuinely shared resource, so the login is
 * the one narrow step that legitimately serializes. Everything after the
 * redirect runs fully in parallel.
 *
 * The lock is a crash-safe single global lock file: a killed `playwright
 * test` process leaves an orphaned file behind, which is reclaimed by age.
 */
export async function withLoginMutex<T>(
  _role: "student" | "lecturer" | "admin",
  fn: () => Promise<T>
): Promise<T> {
  await ensureLockDir();
  const lockContent = `${process.pid}-${Date.now()}-${Math.random()}`;
  await acquireLock(lockContent);
  try {
    return await fn();
  } finally {
    await releaseLock(lockContent);
  }
}