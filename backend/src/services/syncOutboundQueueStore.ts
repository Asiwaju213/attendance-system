import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import type { AttendanceRecordStatus } from "../types/attendanceSession";

/**
 * The edge's outbound attendance queue (Task 3).
 *
 * This module owns one idea: a mark recorded on the edge becomes durable work for
 * the cloud in the SAME transaction that records it. That single property is what
 * makes the edge usable with no uplink at all - the marking request never contacts
 * the cloud, never waits on it, and cannot succeed locally while losing the upload.
 *
 * It deliberately contains no network code. Task 4's uploader drains what this
 * module queues, so the offline path and the online path share exactly one
 * definition of "this mark still needs to reach the cloud".
 */

export type OutboundMarkStatus = "PENDING" | "SENT" | "REJECTED";

export interface OutboundAttendanceMark {
  queueId: string;
  /**
   * The local attendance record this upload describes. NULL for a mark against a
   * cloud-created session, which has no canonical record on the edge (migration
   * 023); such a mark is addressed on the wire by `sessionSyncId` alone.
   */
  attendanceRecordId: number | null;
  sessionSyncId: string;
  studentId: number;
  matricNumber: string;
  markStatus: AttendanceRecordStatus;
  markTime: string;
  queuedAt: string;
}

interface OutboundRow {
  queue_id: string;
  attendance_record_id: string | null;
  session_sync_id: string;
  student_id: string;
  matric_number: string;
  mark_status: AttendanceRecordStatus;
  mark_time: Date;
  queued_at: Date;
}

function toMark(row: OutboundRow): OutboundAttendanceMark {
  return {
    queueId: row.queue_id,
    attendanceRecordId:
      row.attendance_record_id === null ? null : Number(row.attendance_record_id),
    sessionSyncId: row.session_sync_id,
    studentId: Number(row.student_id),
    matricNumber: row.matric_number,
    markStatus: row.mark_status,
    markTime: row.mark_time.toISOString(),
    queuedAt: row.queued_at.toISOString(),
  };
}

const MARK_COLUMNS = `m.queue_id, m.attendance_record_id, m.session_sync_id,
                      m.student_id, m.matric_number, m.mark_status, m.mark_time, m.queued_at`;

/**
 * Per-row retry backoff for marks whose last upload attempt failed (Task 4).
 *
 * A `RETRY` verdict returns a row to PENDING with its `attempts` incremented, so
 * without a gate the very next drain re-sends it. That is correct once, but
 * during a sustained cloud outage (or a misconfiguration the cloud answers 5xx
 * to) it turns into a fixed-interval retry storm: the same marks hit the cloud
 * every poll, forever, with no backoff because the upload path never throws.
 *
 * The gate lives in the claim's WHERE clause: a PENDING row that has failed
 * before is not claimable until `last_attempt_at` is older than the delay for
 * its attempt count. A fresh row (attempts = 0) is never gated, and ordering is
 * untouched - the claim still returns rows by `(queued_at, queue_id)`, it simply
 * does not select rows that are not due yet.
 *
 * The schedule mirrors the worker's inbound backoff philosophy but on a longer
 * horizon: 2s, 5s, 10s, 30s, 60s, 2m, 4m, then 5m for every further attempt.
 */
const RETRY_BACKOFF_SCHEDULE_MS = [
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  240_000,
] as const;
const RETRY_BACKOFF_CAP_MS = 300_000;

/** The delay the claim enforces before a row with `attempts` is retried. */
export function retryBackoffDelayMs(attempts: number): number {
  if (attempts <= 0) {
    return 0;
  }
  if (attempts <= RETRY_BACKOFF_SCHEDULE_MS.length) {
    return RETRY_BACKOFF_SCHEDULE_MS[attempts - 1];
  }
  return RETRY_BACKOFF_CAP_MS;
}

/**
 * The backoff schedule as a seconds-per-attempts array, plus its cap, for the
 * claim's SQL. Kept as parameters (rather than a CASE expression mirroring the
 * JS helper) so the schedule has exactly one source of truth.
 */
const RETRY_BACKOFF_SCHEDULE_SECS = RETRY_BACKOFF_SCHEDULE_MS.map((ms) => ms / 1000);
const RETRY_BACKOFF_CAP_SECS = RETRY_BACKOFF_CAP_MS / 1000;

/**
 * Queue one local attendance record for upload, using the CALLER's transaction.
 *
 * Takes a `PoolClient` rather than reaching for `pool`, for the same reason
 * `appendChangeEvent` does on the cloud side: this has to commit together with the
 * `attendance_records` INSERT, or the edge could record a mark that the cloud will
 * never hear about (if the queue insert were lost) or queue a mark that was rolled
 * back (if the mark were lost). Neither is acceptable for attendance data.
 *
 * Everything the queue needs is resolved from the record itself inside the same
 * transaction, so the queue cannot describe something other than what was written:
 *
 *   - `session_sync_id` is the local session's `sync_id`, which IS the cloud's
 *     identity for that session. The local integer id is never used on the wire.
 *   - `matric_number` is the natural key the cloud resolves the student by, because
 *     students are deliberately not synchronized.
 *
 * `ON CONFLICT (attendance_record_id) DO UPDATE` is what makes this safe to call
 * more than once for one record. Re-stating the mark (an admin correction) updates
 * the existing row and returns it to PENDING rather than creating a second,
 * conflicting upload, so the cloud ends up with one canonical record.
 *
 * `queued_at` is deliberately NOT touched by the re-queue, so a row keeps the
 * position it has had in the queue since it was first raised. A corrected mark
 * therefore re-uploads ahead of marks that were queued after it, which is what
 * makes a correction land promptly instead of waiting out a long backlog.
 *
 * @returns the queue row's id, or null when the record does not exist.
 */
export async function enqueueAttendanceMark(
  client: PoolClient,
  attendanceRecordId: number
): Promise<string | null> {
  const result = await client.query(
    `WITH resolved AS (
       SELECT ar.id AS record_id,
              s.sync_id AS session_sync_id,
              st.id AS student_id,
              st.matric_number,
              ar.status AS mark_status,
              ar.marked_at AS mark_time
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       JOIN students st ON st.id = ar.student_id
       WHERE ar.id = $1
     )
     INSERT INTO sync_outbound_attendance_marks
       (attendance_record_id, session_sync_id, student_id, matric_number, mark_status, mark_time)
     SELECT record_id, session_sync_id, student_id, matric_number, mark_status, mark_time
     FROM resolved
     ON CONFLICT (attendance_record_id) DO UPDATE SET
       mark_status = EXCLUDED.mark_status,
       mark_time = EXCLUDED.mark_time,
       status = 'PENDING',
       attempts = 0,
       last_attempt_at = NULL,
       last_error = NULL,
       sent_at = NULL,
       cloud_record_id = NULL
     RETURNING queue_id`,
    [attendanceRecordId]
  );

  const row = result.rows[0];
  return row ? (row.queue_id as string) : null;
}

/**
 * Queue a mark against a CLOUD-created session for upload (Task 4), using the
 * CALLER's transaction.
 *
 * Unlike `enqueueAttendanceMark`, there is no canonical `attendance_records` row
 * on the edge to resolve from, so the caller passes the session, student and
 * derived status explicitly. `attendance_record_id` stays NULL and the row is
 * addressed on the wire by `sessionSyncId` + `matricNumber`, exactly like a local
 * mark.
 *
 * Exactly-once is enforced by the partial unique index
 * `one_cloud_mark_per_student_session` (migration 023): a second mark for the
 * same (student, session) has no ON CONFLICT row to update and is absorbed as a
 * no-op, which the caller reports as ALREADY_MARKED. That is the concurrency
 * backstop that makes a race between two marking requests produce exactly one
 * upload instead of two.
 *
 * @returns the queue row's id and its `mark_time`, or null when this student has
 *          already marked this cloud session.
 */
export async function enqueueCloudSessionMark(
  client: PoolClient,
  sessionSyncId: string,
  studentId: number,
  matricNumber: string,
  markStatus: AttendanceRecordStatus,
  markTime: Date
): Promise<{ queueId: string; markTime: string } | null> {
  const result = await client.query(
    `INSERT INTO sync_outbound_attendance_marks
       (attendance_record_id, session_sync_id, student_id, matric_number, mark_status, mark_time)
     VALUES (NULL, $1, $2, $3, $4, $5)
     ON CONFLICT (student_id, session_sync_id)
       WHERE attendance_record_id IS NULL
     DO NOTHING
     RETURNING queue_id, mark_time`,
    [sessionSyncId, studentId, matricNumber, markStatus, markTime]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    queueId: row.queue_id as string,
    markTime: (row.mark_time as Date).toISOString(),
  };
}

/**
 * Claim the oldest pending uploads, oldest first (Task 5).
 *
 * A claim is a lease: the rows are moved to IN_FLIGHT with `claimed_by` and
 * `claimed_at` so no other drain selects them, and the claim expires after
 * `ttlMs` when a later drain takes it back. Ordering is by `(queued_at,
 * queue_id)` rather than by a random or insertion-only key: two marks queued in
 * the same millisecond must still come back in a stable order across ticks, or
 * the upload order for a session would not be reproducible. The queue_id
 * tiebreak makes the order total.
 *
 * One UPDATE does the whole job, and that statement is what makes the claim
 * correct, not a transaction around two queries:
 *
 *   - `FOR UPDATE SKIP LOCKED` means two drains running at once cannot claim the
 *     same row - the second skips what the first locked and takes the next batch.
 *     The cloud's receipts made a duplicate send safe; the claim makes it
 *     impossible to send.
 *   - an expired claim is selected in the SAME query, still ordered by its
 *     original `queued_at`, so a dead worker's batch returns to the queue in its
 *     original position rather than jumping ahead of marks enqueued since.
 *
 * `ttlMs` is clamped so a negative or absurd value cannot make every claim
 * instantly reclaimable or effectively permanent.
 *
 * A PENDING row whose last attempt failed is only selected once its per-row
 * retry backoff (`retryBackoffDelayMs`) has elapsed, so a sustained outage
 * spreads retries instead of re-sending the same marks every poll. The backoff
 * filter never reorders a row within the claim: selection stays by
 * `(queued_at, queue_id)`.
 */
export async function claimPendingUploads(
  limit: number,
  claimerId: string,
  ttlMs: number
): Promise<OutboundAttendanceMark[]> {
  const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const claimableTtlSecs = Math.min(Math.max(1, Math.trunc(ttlMs)), 3_600_000) / 1000;
  // One statement does the whole job. `claimed` locks the rows IN the order the
  // uploader must send them (FOR UPDATE SKIP LOCKED), `updated` flips them to
  // IN_FLIGHT, and the final SELECT returns them in the SAME order - RETURNING
  // comes back in whichever order the UPDATE happened to touch the rows, which is
  // not reproducible, so the rows are joined back to `claimed` and ordered.
  const result = await pool.query(
    `WITH claimed AS (
       SELECT queue_id
       FROM sync_outbound_attendance_marks
       WHERE (status = 'PENDING'
                AND (attempts = 0
                     OR last_attempt_at IS NULL
                     OR last_attempt_at <= now() - make_interval(secs =>
                           LEAST(COALESCE(($4::int[])[attempts], $5::int), $5::int))))
          OR (status = 'IN_FLIGHT' AND claimed_at <= now() - make_interval(secs => $2))
       ORDER BY queued_at ASC, queue_id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ),
     updated AS (
       UPDATE sync_outbound_attendance_marks m
       SET status = 'IN_FLIGHT',
           claimed_at = now(),
           claimed_by = $3,
           updated_at = now()
       FROM claimed
       WHERE m.queue_id = claimed.queue_id
       RETURNING m.queue_id
     )
     SELECT ${MARK_COLUMNS}
     FROM sync_outbound_attendance_marks m
     JOIN claimed ON claimed.queue_id = m.queue_id
     ORDER BY m.queued_at ASC, m.queue_id ASC`,
    [
      boundedLimit,
      claimableTtlSecs,
      claimerId,
      RETRY_BACKOFF_SCHEDULE_SECS,
      RETRY_BACKOFF_CAP_SECS,
    ]
  );
  return result.rows.map((row) => toMark(row as OutboundRow));
}

/**
 * Give a claimed batch back before its result is known.
 *
 * The uploader calls this when the request ITSELF fails (unknown outcome): the
 * cloud may or may not have received the batch, so the rows are not sent, but
 * they must also not sit claimed while a healthy process can just retry next
 * tick. Only a few lines upstream this function stays OUT of the dead-worker
 * path - a crash leaves the rows IN_FLIGHT for the lease to reclaim, which is
 * exactly the case the lease exists for.
 */
export async function releaseUploadClaim(queueIds: string[]): Promise<void> {
  if (queueIds.length === 0) {
    return;
  }
  await pool.query(
    `UPDATE sync_outbound_attendance_marks
     SET status = 'PENDING',
         claimed_at = NULL,
         claimed_by = NULL
     WHERE queue_id = ANY($1::uuid[]) AND status = 'IN_FLIGHT'`,
    [queueIds]
  );
}

/**
 * The number of IN_FLIGHT rows whose lease is already longer than `minAgeMs`.
 *
 * This is the "is the queue stuck because a worker died?" signal. `inFlight`
 * on its own is ambiguous - it also counts a batch a healthy uploader is sending
 * right now - while a claim older than the configured lease can only mean the
 * process that took it is gone or wedged. The count is what the health surface
 * reports; `releaseStaleUploadClaims` is the recovery that follows it.
 */
export async function countStaleUploadClaims(minAgeMs: number): Promise<number> {
  const boundedSecs = Math.min(Math.max(1, Math.trunc(minAgeMs)), 3_600_000) / 1000;
  const result = await pool.query(
    `SELECT count(*)::int AS n
     FROM sync_outbound_attendance_marks
     WHERE status = 'IN_FLIGHT'
       AND claimed_at <= now() - make_interval(secs => $1)`,
    [boundedSecs]
  );
  return Number(result.rows[0].n ?? 0);
}

/**
 * Release IN_FLIGHT claims whose lease is longer than `minAgeMs`, back to PENDING.
 *
 * The operator-side counterpart to the claim's lease: the lease is what lets a
 * HEALTHY process reclaim a dead worker's batch, and this is what an operator can
 * do when no worker is running at all (a PC kept offline, a process that will not
 * be restarted soon). The age threshold is enforced, not advisory, so a claim a
 * live uploader just took is never preempted: only claims older than the
 * threshold are touched. A subsequent re-send of an already-delivered batch stays
 * harmless, because the cloud keys its receipts on `queue_id`.
 *
 * @returns how many claims were released.
 */
export async function releaseStaleUploadClaims(minAgeMs: number): Promise<number> {
  const boundedSecs = Math.min(Math.max(1, Math.trunc(minAgeMs)), 3_600_000) / 1000;
  const result = await pool.query(
    `UPDATE sync_outbound_attendance_marks
     SET status = 'PENDING',
         claimed_at = NULL,
         claimed_by = NULL
     WHERE status = 'IN_FLIGHT'
       AND claimed_at <= now() - make_interval(secs => $1)`,
    [boundedSecs]
  );
  return result.rowCount ?? 0;
}

/** Why an upload left the PENDING state. */
export type UploadOutcome =
  | { outcome: "SENT"; cloudRecordId: number | null }
  | { outcome: "REJECTED"; reason: string }
  | { outcome: "RETRY"; reason: string };

/**
 * Record the result of one upload attempt.
 *
 * A transport failure is `RETRY`: the row leaves its claim and returns to PENDING,
 * the attempt counter goes up and the reason is kept, so the next drain can back
 * off and Task 6 can show why the queue is not draining. Only an outcome the cloud
 * will never accept moves the row to REJECTED, and only `SENT` clears the error.
 *
 * Every outcome also clears `claimed_at`/`claimed_by`: the claim is work in
 * progress, and a row that now has a verdict is not in progress any more.
 *
 * `last_error` is cleared on success so a queue that recovered does not keep
 * displaying a stale reason.
 */
export async function recordUploadResult(
  queueId: string,
  result: UploadOutcome
): Promise<void> {
  if (result.outcome === "SENT") {
    await pool.query(
      `UPDATE sync_outbound_attendance_marks
       SET status = 'SENT',
           attempts = attempts + 1,
           last_attempt_at = now(),
           last_error = NULL,
           sent_at = now(),
           cloud_record_id = $2,
           claimed_at = NULL,
           claimed_by = NULL
       WHERE queue_id = $1`,
      [queueId, result.cloudRecordId]
    );
    return;
  }

  if (result.outcome === "REJECTED") {
    await pool.query(
      `UPDATE sync_outbound_attendance_marks
       SET status = 'REJECTED',
           attempts = attempts + 1,
           last_attempt_at = now(),
           last_error = $2,
           claimed_at = NULL,
           claimed_by = NULL
       WHERE queue_id = $1`,
      [queueId, result.reason]
    );
    return;
  }

  await pool.query(
    `UPDATE sync_outbound_attendance_marks
     SET status = 'PENDING',
         attempts = attempts + 1,
         last_attempt_at = now(),
         last_error = $2,
         claimed_at = NULL,
         claimed_by = NULL
     WHERE queue_id = $1`,
    [queueId, result.reason]
  );
}

/**
 * Return a REJECTED mark to PENDING.
 *
 * Used by an operator-driven retry after the reason it was rejected is understood
 * and fixed. There is no automatic path into this: a mark the cloud refused is not
 * something the edge should quietly try again, because the refusal usually means
 * the edge is missing master data that only a human can resolve.
 */
export async function requeueRejectedMark(queueId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sync_outbound_attendance_marks
     SET status = 'PENDING', attempts = 0, last_error = NULL
     WHERE queue_id = $1 AND status = 'REJECTED'`,
    [queueId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Queue depth by status, plus the age of the oldest pending mark. */
export interface OutboundQueueSummary {
  pending: number;
  inFlight: number;
  sent: number;
  rejected: number;
  /**
   * PENDING rows that have already failed at least once (attempts > 0). These
   * are the marks the cloud has refused-or-missed and the edge is backing off;
   * a non-zero count alongside `lastError` is the "failed uploads" diagnostic,
   * distinct from rows that have never been sent.
   */
  retrying: number;
  oldestPendingAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

/**
 * A single-query view of the queue for the Task 6 health surface.
 *
 * Computed with aggregates over the indexed status column rather than by reading
 * rows, so asking "is the edge keeping up?" never scans the queue.
 */
export async function readOutboundQueueSummary(): Promise<OutboundQueueSummary> {
  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'PENDING')                        AS pending,
       count(*) FILTER (WHERE status = 'IN_FLIGHT')                      AS in_flight,
       count(*) FILTER (WHERE status = 'SENT')                           AS sent,
       count(*) FILTER (WHERE status = 'REJECTED')                       AS rejected,
       count(*) FILTER (WHERE status = 'PENDING' AND attempts > 0)       AS retrying,
       min(queued_at) FILTER (WHERE status = 'PENDING')                  AS oldest_pending,
       max(sent_at)                                                       AS last_sent,
       max(last_error) FILTER (
         WHERE status = 'PENDING' AND last_error IS NOT NULL
       )                                                                 AS last_error
     FROM sync_outbound_attendance_marks`
  );

  const row = result.rows[0];
  return {
    pending: Number(row.pending ?? 0),
    inFlight: Number(row.in_flight ?? 0),
    sent: Number(row.sent ?? 0),
    rejected: Number(row.rejected ?? 0),
    retrying: Number(row.retrying ?? 0),
    oldestPendingAt: row.oldest_pending
      ? new Date(row.oldest_pending as Date).toISOString()
      : null,
    lastSentAt: row.last_sent ? new Date(row.last_sent as Date).toISOString() : null,
    lastError: (row.last_error as string | null) ?? null,
  };
}