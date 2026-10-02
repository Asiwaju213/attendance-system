import { pool } from "../db/pool";
import { syncConfig } from "../config/sync";
import { readOutboundQueueSummary } from "./syncOutboundQueueStore";
import { getSyncStatus } from "./syncStatusStore";

/**
 * The operator-visible synchronization health snapshot (Task 6).
 *
 * The worker's in-memory status alone is not enough to answer the question an
 * operator actually has on a K12 PC that may have been offline all week:
 *
 *   "Is my attendance data safe, and is it actually reaching the cloud?"
 *
 * That needs both directions at once - the INBOUND side (is this edge receiving
 * master data, and how far behind is it) and the OUTBOUND side (are marks piling up
 * unsent, and has anything been rejected outright). Reporting them separately means
 * two screen refreshes and a mental join, at exactly the moment something is wrong.
 *
 * Everything here is derived, never stored. There is no health table to migrate, no
 * row to clean up, and no way for this snapshot to disagree with reality - if the
 * queue stops draining, `pending` rises on the next request with no further work.
 */

/** Which side of the synchronization this deployment is playing. */
export type SyncRole = "EDGE" | "PROVIDER" | "STANDALONE";

export interface SyncInboundHealth {
  enabled: boolean;
  running: boolean;
  consumerId: string | null;
  /** The last feed cursor durably applied to this edge. */
  lastCursor: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}

export interface SyncOutboundHealth {
  pending: number;
  sent: number;
  rejected: number;
  oldestPendingAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  /**
   * Whether the queue is backing up rather than merely holding a batch.
   *
   * A pending count on its own is ambiguous: a single mark is normal mid-tick, a
   * thousand is an incident. Comparing the age of the oldest pending mark against
   * the configured poll interval separates "waiting for the next tick" from
   * "has not moved in many ticks", which is the distinction an operator needs and
   * the only one that survives the queue simply being large.
   */
  backlogged: boolean;
}

export interface SyncHealthSnapshot {
  role: SyncRole;
  inbound: SyncInboundHealth;
  outbound: SyncOutboundHealth;
  /**
   * A single overall verdict, so a monitoring check does not have to reimplement the
   * rules that decide whether this deployment is healthy.
   *
   * "OFFLINE" outranks "DEGRADED": an edge that cannot reach the cloud at all is a
   * different problem from one that can reach it but has work it cannot complete.
   * Neither is "UNHEALTHY" in the sense of data loss - marks are queued durably in
   * both cases - so both are still "OK" for the question that matters most, which is
   * whether student attendance is being recorded.
   */
  state: "OK" | "DEGRADED" | "OFFLINE" | "STANDALONE";
}

/**
 * Classify the deployment.
 *
 * A PC with no cloud configured at all is STANDALONE and is perfectly healthy - it
 * is simply not participating in synchronization. That must not be reported as a
 * fault, or every unconfigured deployment would show a permanent warning.
 */
function resolveRole(): SyncRole {
  if (syncConfig.consumer.enabled) {
    return "EDGE";
  }
  return syncConfig.provider.secretHash !== null ? "PROVIDER" : "STANDALONE";
}

/**
 * Assemble the snapshot.
 *
 * The queue read is allowed to fail without failing the whole request: an operator
 * asking "is my sync healthy" during a database blip should still get the inbound
 * half and a DEGRADED verdict, rather than a 500 that tells them nothing.
 */
export async function getSyncHealth(): Promise<SyncHealthSnapshot> {
  const role = resolveRole();
  const workerStatus = getSyncStatus();

  let outbound: SyncOutboundHealth = {
    pending: 0,
    sent: 0,
    rejected: 0,
    oldestPendingAt: null,
    lastSentAt: null,
    lastError: null,
    backlogged: false,
  };

  try {
    const summary = await readOutboundQueueSummary();
    outbound = {
      ...summary,
      // Two missed poll intervals: long enough that a slow tick or a brief outage is
      // not reported, short enough that a genuinely stuck queue is noticed quickly.
      backlogged:
        summary.oldestPendingAt !== null &&
        Date.now() - Date.parse(summary.oldestPendingAt) >
          2 * syncConfig.consumer.intervalMs,
    };
  } catch (error) {
    console.error(
      "Outbound queue health read failed.",
      (error as Error).message
    );
    outbound = { ...outbound, lastError: "The outbound queue could not be read." };
  }

  const inbound: SyncInboundHealth = {
    enabled: workerStatus.enabled,
    running: workerStatus.running,
    consumerId: workerStatus.consumerId,
    lastCursor: workerStatus.lastCursor,
    lastSuccessAt: workerStatus.lastSuccessAt,
    lastAttemptAt: workerStatus.lastAttemptAt,
    lastErrorMessage: workerStatus.lastErrorMessage,
    consecutiveFailures: workerStatus.consecutiveFailures,
  };

  return { role, inbound, outbound, state: resolveState(role, inbound, outbound) };
}

/**
 * The verdict, in priority order.
 *
 * Deliberately NOT treating `rejected > 0` as a health failure. A rejected mark is
 * already recorded locally and durably queued - no attendance data is at risk - and
 * the mark is parked precisely so that a human deals with it. Folding it into the
 * overall state would train operators to ignore a permanently non-OK badge. It is
 * surfaced as `outbound.rejected` for that human to act on instead.
 */
function resolveState(
  role: SyncRole,
  inbound: SyncInboundHealth,
  outbound: SyncOutboundHealth
): SyncHealthSnapshot["state"] {
  if (role === "STANDALONE") {
    return "STANDALONE";
  }
  if (role === "PROVIDER") {
    // The cloud serves the feed; it has no local worker and no outbound queue.
    return "OK";
  }
  // Edge: offline means the cloud has been unreachable across many attempts.
  if (inbound.consecutiveFailures >= 3 || !inbound.running) {
    return "OFFLINE";
  }
  if (outbound.backlogged || inbound.consecutiveFailures > 0) {
    return "DEGRADED";
  }
  return "OK";
}

/**
 * Marks the cloud refused, newest first.
 *
 * Bounded and ADMIN-only: a rejection reason can describe a student and a course,
 * which is attendance data, so it is served under the same authorization rules as
 * any other attendance query and never through the edge-credential status endpoint.
 */
export interface RejectedMarkReport {
  queueId: string;
  sessionSyncId: string;
  matricNumber: string;
  markStatus: string;
  attempts: number;
  lastError: string;
  lastAttemptAt: string | null;
  queuedAt: string;
}

export async function listRejectedAttendanceMarks(
  limit: number
): Promise<RejectedMarkReport[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100);
  const result = await pool.query(
    `SELECT queue_id, session_sync_id, matric_number, mark_status,
            attempts, last_error, last_attempt_at, queued_at
     FROM sync_outbound_attendance_marks
     WHERE status = 'REJECTED'
     ORDER BY queued_at DESC, queue_id DESC
     LIMIT $1`,
    [bounded]
  );

  return result.rows.map((row) => ({
    queueId: row.queue_id as string,
    sessionSyncId: row.session_sync_id as string,
    matricNumber: row.matric_number as string,
    markStatus: row.mark_status as string,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? "No reason recorded.",
    lastAttemptAt: row.last_attempt_at
      ? new Date(row.last_attempt_at as Date).toISOString()
      : null,
    queuedAt: new Date(row.queued_at as Date).toISOString(),
  }));
}