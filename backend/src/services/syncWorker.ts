import { syncConfig, type SyncConsumerConfig } from "../config/sync";
import { applyChangeBatch, readCursor } from "./syncApplyService";
import { SyncFeedError, fetchChangeBatch } from "./syncFeedClient";
import { uploadPendingAttendanceMarks } from "./syncAttendanceUploader";
import {
  getSyncStatus,
  recordSyncAttempt,
  recordSyncFailure,
  recordSyncStarted,
  recordSyncStopped,
  recordSyncSuccess,
  setSyncStatusEnabled,
} from "./syncStatusStore";
import type { SyncChangesBatch } from "../types/sync";

/**
 * Guards against accidentally running the edge sync worker on a cloud/provider deployment.
 *
 * The cloud is the sync PROVIDER (serves the feed) and must never also run the
 * CONSUMER worker. A deployment is a provider if SYNC_PROVIDER_SECRET_HASH is set.
 * If a provider deployment also has SYNC_ENABLED=true with valid consumer config,
 * that is a misconfiguration and we fail fast rather than silently starting the
 * wrong worker.
 */
function assertNotProviderRunningConsumer(): void {
  const isProvider = syncConfig.provider.secretHash !== null;
  const isConsumerEnabled = syncConfig.consumer.enabled;

  if (isProvider && isConsumerEnabled) {
    const msg = [
      "FATAL: This deployment is configured as a sync PROVIDER (SYNC_PROVIDER_SECRET_HASH is set)",
      "but also has consumer sync enabled (SYNC_ENABLED=true with SYNC_EDGE_ID, SYNC_EDGE_SECRET, SYNC_CLOUD_BASE_URL).",
      "A cloud/provider deployment must never run the edge sync worker.",
      "Either remove SYNC_PROVIDER_SECRET_HASH to run as an edge,",
      "or unset SYNC_ENABLED (and SYNC_EDGE_ID / SYNC_EDGE_SECRET / SYNC_CLOUD_BASE_URL) to run as a provider.",
    ].join(" ");
    throw new Error(msg);
  }
}

/**
 * The local K12 sync worker.
 *
 * Runs as a module alongside the local backend. It is NOT a second HTTP server
 * and it does not add a port, a listener or a health endpoint of its own - it
 * only makes outbound requests to the cloud, so the local server keeps serving
 * students on the K12 LAN whether or not the cloud is reachable.
 *
 * Startup never depends on the cloud: nothing here runs during boot. The first
 * attempt happens on the first tick, and a failure is a logged, retried state
 * rather than a thrown error, so an offline PC boots perfectly well.
 */

/**
 * Bounded exponential backoff.
 *
 * 2s, 5s, 10s, 30s, then 60s for every attempt after that. The final value is
 * the cap, so a long Render outage settles into a once-a-minute poll instead of
 * either hammering the cloud or never recovering.
 */
const BACKOFF_SCHEDULE_MS = [2_000, 5_000, 10_000, 30_000] as const;
const BACKOFF_CAP_MS = 60_000;

/**
 * Upper bound on batches drained per tick.
 *
 * `hasMore` normally drives the drain loop directly, but a bounded number of
 * batches per tick stops a very large backlog from monopolising the local
 * database and starving student requests, which matter more than catching up.
 */
const MAX_BATCHES_PER_TICK = 20;

/** Delay used when stopping, so shutdown does not wait out a backoff. */
const SHUTDOWN_POLL_MS = 250;

/**
 * Delay before the next attempt, given how many consecutive failures preceded it.
 *
 * Exported so the schedule itself can be asserted directly rather than by
 * waiting out real timers in a test.
 */
export function computeBackoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  const index = consecutiveFailures - 1;
  if (index < BACKOFF_SCHEDULE_MS.length) {
    return BACKOFF_SCHEDULE_MS[index];
  }
  return BACKOFF_CAP_MS;
}

/**
 * One page: read the cursor, fetch one bounded page, apply it, and record the
 * outcome.
 *
 * Failure recording lives here rather than in the callers so that BOTH
 * `runSyncOnce` and the worker's own `drain` loop update the consecutive-failure
 * counter. Without that, the counter would stay at 0 on the worker's real path,
 * `computeBackoffDelayMs(0)` would return 0, and a disconnected PC would retry
 * the cloud in a tight loop instead of backing off.
 */
async function attemptOnce(
  config: SyncConsumerConfig,
  cursor: number
): Promise<SyncChangesBatch> {
  recordSyncAttempt(config.consumerId, cursor);

  let batch: SyncChangesBatch;
  try {
    batch = await fetchChangeBatch(cursor, config.batchLimit, config);
  } catch (error) {
    recordSyncFailure(describeFailure(error));
    throw error;
  }

  try {
    const result = await applyChangeBatch(config.consumerId, batch.events);
    // Records the applied cursor and resets the consecutive-failure counter.
    recordSyncSuccess(config.consumerId, result.cursor);
  } catch (error) {
    recordSyncFailure(describeFailure(error));
    throw error;
  }

  return batch;
}

/**
 * Turn an error into an operator-facing status message.
 *
 * A non-retryable failure (a wrong or missing credential) is called out
 * explicitly, because retrying it unchanged will never succeed and the fix is a
 * configuration change rather than a transient outage.
 */
function describeFailure(error: unknown): string {
  if (error instanceof SyncFeedError) {
    return error.retryable
      ? error.message
      : `${error.message} Not retryable until the edge configuration changes.`;
  }
  return `Unexpected sync failure: ${(error as Error).message}`;
}

/**
 * One full synchronization attempt.
 *
 * Exported so it can be tested directly, without a timer: a test can drive
 * exactly one attempt against a stubbed feed client and assert on the cursor.
 */
export async function runSyncOnce(config: SyncConsumerConfig): Promise<number> {
  const cursor = await readCursor(config.consumerId);
  const batch = await attemptOnce(config, cursor);
  return batch.nextCursor;
}

/** Drain consecutive pages while the cloud says more remain. */
async function drain(config: SyncConsumerConfig): Promise<void> {
  for (let page = 0; page < MAX_BATCHES_PER_TICK; page += 1) {
    const cursor = await readCursor(config.consumerId);
    const batch = await attemptOnce(config, cursor);

    if (!batch.hasMore) {
      return;
    }
    // A page that reported more but advanced nothing would loop forever.
    if (batch.nextCursor <= cursor) {
      recordSyncFailure(
        "Cloud sync feed reported more changes but did not advance the cursor."
      );
      throw new SyncFeedError(
        "Cloud sync feed reported more changes but did not advance the cursor.",
        true
      );
    }
  }
}

/**
 * Push the local attendance queue to the cloud (Task 4).
 *
 * Runs BEFORE the inbound drain and fails independently of it, for two reasons.
 *
 * The independence is the important one: these are different directions with
 * different failure modes. A broken upload (bad credential, cloud down) must not
 * stop the edge from still receiving master data, and a feed error must not strand
 * the attendance queue. Coupling them would mean one outage stalls synchronization
 * in both directions at once.
 *
 * Uploading first is a deliberate ordering choice: the marks queued locally are the
 * data the school actually cannot lose, and pushing them out before pulling in
 * master data means a tick that can only do one thing spends it on the safer one.
 */
async function uploadOnce(): Promise<void> {
  try {
    const summary = await uploadPendingAttendanceMarks();
    if (summary.attempted > 0) {
      console.log(
        `Attendance upload: ${summary.accepted} accepted, ${summary.rejected} rejected, ` +
          `${summary.deferred} deferred of ${summary.attempted} attempted.`
      );
    }
  } catch (error) {
    // Not rethrown: the inbound drain still runs, and the outcome is visible in the
    // status/queue health surface rather than by aborting the tick.
    recordSyncFailure(`Attendance upload: ${describeFailure(error)}`);
    console.error(`Attendance upload failed. ${describeFailure(error)}`);
  }
}

let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Start the worker.
 *
 * Returns immediately. `SYNC_ENABLED` must be set AND the consumer configuration
 * must be complete, or this does nothing - so importing this module, or starting
 * the backend, on a machine that has no edge configuration at all is harmless.
 */
export function startSyncWorker(): void {
  const config = syncConfig.consumer;
  setSyncStatusEnabled(config.enabled, config.enabled ? config.consumerId : null);

  if (!config.enabled) {
    return;
  }

  // Hard guard: a cloud/provider deployment must never run the edge worker.
  assertNotProviderRunningConsumer();

  // Belt and braces alongside the NODE_ENV=test check in index.ts: a test run must
  // never reach out to a real cloud, no matter how the environment is configured.
  if (process.env.NODE_ENV === "test") {
    console.log(
      "Sync worker not started: NODE_ENV=test. The local sync worker never runs during tests."
    );
    return;
  }

  if (running) {
    return;
  }
  running = true;
  stopRequested = false;

  const initialCursor = readCursor(config.consumerId).catch(() => 0);
  initialCursor
    .then((cursor) => {
      recordSyncStarted(config.consumerId, cursor);
      console.log(
        `Cloud sync worker started for edge "${config.consumerId}" from cursor ${cursor}.`
      );
    })
    .catch(() => {
      recordSyncStarted(config.consumerId, 0);
    });

  const tick = async (): Promise<void> => {
    if (stopRequested) {
      return;
    }

    let delay = config.intervalMs;
    try {
      await uploadOnce();
      await drain(config);
    } catch (error) {
      const failures = getSyncStatus().consecutiveFailures;
      const nonRetryable = error instanceof SyncFeedError && !error.retryable;
      // A wrong credential is not a transient outage, so short backoff steps would
      // just hammer the cloud with a request that can never succeed. Fall back to
      // the once-a-minute cap; it is not fatal, because the backend keeps serving
      // students and an operator who fixes the credential should not have to
      // restart the process.
      delay = nonRetryable
        ? BACKOFF_CAP_MS
        : computeBackoffDelayMs(failures);
      console.error(`Cloud sync attempt failed. ${describeFailure(error)}`);
      console.error(
        `Cloud sync retrying in ${Math.round(delay / 1000)}s. The local server continues to serve students regardless.`
      );
    }

    if (stopRequested) {
      return;
    }
    // `unref` keeps a pending sync timer from holding the process open, matching
    // lib/rateLimit.ts.
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref();
  };

  timer = setTimeout(() => {
    void tick();
  }, 0);
  timer.unref();
}

/** Stop the worker. Safe to call when it was never started. */
export function stopSyncWorker(): void {
  stopRequested = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (running) {
    console.log("Cloud sync worker stopping.");
  }
  running = false;
  recordSyncStopped();
}

export function isSyncWorkerRunning(): boolean {
  return running;
}

/** Test-only: whether a shutdown has been requested. */
export function isStopRequested(): boolean {
  return stopRequested;
}

/** Re-exported for the shutdown path's polling loop. */
export const SYNC_SHUTDOWN_POLL_MS = SHUTDOWN_POLL_MS;