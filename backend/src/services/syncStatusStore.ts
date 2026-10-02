import type { SyncWorkerStatus } from "../types/sync";

/**
 * In-memory snapshot of the local sync worker's state.
 *
 * Deliberately process-local: it reports what THIS backend instance has done, and
 * a future admin UI would read it from this instance. Nothing here is persisted,
 * so nothing here needs to be migrated or cleaned up.
 *
 * It holds no credential material. The cloud base URL is not included either -
 * it is not secret, but it is configuration that belongs in the environment, not
 * in an API response.
 */

let status: SyncWorkerStatus = {
  enabled: false,
  running: false,
  consumerId: null,
  lastCursor: 0,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastErrorMessage: null,
  consecutiveFailures: 0,
};

export function getSyncStatus(): SyncWorkerStatus {
  return { ...status };
}

export function setSyncStatusEnabled(
  enabled: boolean,
  consumerId: string | null
): void {
  status = { ...status, enabled, consumerId };
}

export function recordSyncStarted(consumerId: string, lastCursor: number): void {
  status = {
    ...status,
    running: true,
    consumerId,
    lastCursor,
  };
}

export function recordSyncStopped(): void {
  status = { ...status, running: false };
}

export function recordSyncAttempt(consumerId: string, lastCursor: number): void {
  status = {
    ...status,
    consumerId,
    lastCursor,
    lastAttemptAt: new Date().toISOString(),
  };
}

export function recordSyncSuccess(consumerId: string, cursor: number): void {
  status = {
    ...status,
    lastCursor: cursor,
    lastSuccessAt: new Date().toISOString(),
    lastErrorMessage: null,
    consecutiveFailures: 0,
  };
}

/**
 * Record a failed attempt.
 *
 * Only the error MESSAGE is stored, never the request. A failure is the most
 * likely moment for a secret to end up in a log, so the message is passed through
 * unchanged from the fetch layer, which never puts the credential in an error.
 */
export function recordSyncFailure(message: string): void {
  status = {
    ...status,
    lastErrorMessage: message,
    consecutiveFailures: status.consecutiveFailures + 1,
  };
}

/** Test-only reset so each suite starts from a known state. */
export function resetSyncStatusForTests(): void {
  status = {
    enabled: false,
    running: false,
    consumerId: null,
    lastCursor: 0,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
  };
}