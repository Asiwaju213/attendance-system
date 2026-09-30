import { promises as fs } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(__dirname, "..", "..", ".playwright-locks");
const LOCK_FILE = join(LOCK_DIR, "login.lock");
const LOCK_STALE_MS = 60_000;
const MAX_ATTEMPTS = 2_400;
const MAX_TRANSIENT_EPERM_RETRIES = 5;
const RETRY_DELAY_MS = 25;

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

async function acquireLock(lockContent: string): Promise<void> {
  await fs.mkdir(LOCK_DIR, { recursive: true });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await withTransientEppermRetry(() =>
        fs.writeFile(LOCK_FILE, lockContent, { flag: "wx" })
      );
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await withTransientEppermRetry(() => fs.stat(LOCK_FILE));
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await withTransientEppermRetry(() => fs.unlink(LOCK_FILE));
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
    `Could not acquire login mutex after ${MAX_ATTEMPTS} attempts. ` +
      `Stale lock files under ${LOCK_DIR} may need manual removal.`
  );
}

async function releaseLock(lockContent: string): Promise<void> {
  try {
    const current = await withTransientEppermRetry(() =>
      fs.readFile(LOCK_FILE, "utf8")
    );
    if (current === lockContent) {
      await withTransientEppermRetry(() => fs.unlink(LOCK_FILE));
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
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
  const lockContent = `${process.pid}-${Date.now()}-${Math.random()}`;
  await acquireLock(lockContent);
  try {
    return await fn();
  } finally {
    await releaseLock(lockContent);
  }
}