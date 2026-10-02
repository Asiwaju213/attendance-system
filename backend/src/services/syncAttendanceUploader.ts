import { syncConfig } from "../config/sync";
import {
  listPendingUploads,
  recordUploadResult,
  type OutboundAttendanceMark,
  type UploadOutcome,
} from "./syncOutboundQueueStore";
import { postAttendanceMarkBatch } from "./syncFeedClient";

/**
 * The edge's outbound uploader (Task 4).
 *
 * Drains `sync_outbound_attendance_marks` to the cloud. It is a network client and
 * nothing else: it holds no attendance rules, decides no outcomes, and contains no
 * SQL for canonical data. All of that lives on the cloud side, which is what keeps
 * the edge unable to disagree with the authority.
 *
 * Crucially, this module is the ONLY thing that moves a mark toward the cloud. The
 * marking path (Task 3) never calls it and never knows it exists; it only writes a
 * queue row. That is what makes an edge with no uplink behave identically to one
 * with a good link, and it is why this can be paused, retried or made slower without
 * any risk to the mark itself.
 */

export interface UploadSummary {
  attempted: number;
  accepted: number;
  rejected: number;
  deferred: number;
}

/**
 * Convert one local queue row into the wire shape.
 *
 * The local `student_id` and `attendance_record_id` are deliberately NOT sent. They
 * are edge-local integers that mean nothing on the cloud, and sending them would
 * invite the cloud to try to resolve a local id. Only the session's `sync_id` (the
 * cloud's own identity for that session) and the student's `matric_number` (the one
 * natural key that exists on both sides) cross the wire.
 *
 * `markedAt` is the record's own `marked_at`, never the queue time, so correcting a
 * mark does not rewrite when the student was originally marked.
 */
function toWireMark(mark: OutboundAttendanceMark): Record<string, unknown> {
  return {
    queueId: mark.queueId,
    sessionSyncId: mark.sessionSyncId,
    matricNumber: mark.matricNumber,
    status: mark.markStatus,
    markedAt: mark.markTime,
  };
}

interface WireOutcome {
  queueId?: unknown;
  result?: unknown;
  cloudRecordId?: unknown;
  reason?: unknown;
}

/**
 * Upload one bounded page of pending marks.
 *
 * Returns a summary rather than throwing on mark-level problems, because partial
 * success is normal: some marks are accepted, some are rejected for a reason only an
 * operator can fix, and a few may need retrying. Only a failure of the REQUEST as a
 * whole throws, and the caller treats that as a sync failure for backoff purposes.
 *
 * The page size is the provider batch limit, so the edge cannot ask for more than
 * the cloud is willing to accept in one request.
 */
export async function uploadPendingAttendanceMarks(): Promise<UploadSummary> {
  const marks = await listPendingUploads(syncConfig.provider.batchLimit);
  if (marks.length === 0) {
    return { attempted: 0, accepted: 0, rejected: 0, deferred: 0 };
  }

  // Any throw from here leaves every row in this page PENDING, untouched. That is
  // the correct handling for an unknown outcome: the cloud may well have recorded
  // the batch and only the response was lost, so advancing any row now would be a
  // guess. The cloud's receipt table makes the eventual retry safe.
  const outcomes = (await postAttendanceMarkBatch(
    marks.map(toWireMark)
  )) as WireOutcome[];

  const byQueueId = new Map<string, WireOutcome>();
  for (const outcome of outcomes) {
    if (typeof outcome?.queueId === "string") {
      byQueueId.set(outcome.queueId, outcome);
    }
  }

  const summary: UploadSummary = {
    attempted: marks.length,
    accepted: 0,
    rejected: 0,
    deferred: 0,
  };

  for (const mark of marks) {
    const outcome = byQueueId.get(mark.queueId);
    let result: UploadOutcome;

    if (outcome === undefined) {
      // The cloud answered 200 but said nothing about this mark. It stays PENDING:
      // a missing answer is not a rejection, and inventing one would silently drop
      // attendance. Task 6 makes the resulting queue depth visible.
      result = {
        outcome: "RETRY",
        reason: "The cloud returned no outcome for this mark.",
      };
    } else if (outcome.result === "ACCEPTED") {
      result = {
        outcome: "SENT",
        cloudRecordId:
          typeof outcome.cloudRecordId === "number" ? outcome.cloudRecordId : null,
      };
    } else {
      result = {
        outcome: "REJECTED",
        reason:
          typeof outcome.reason === "string" && outcome.reason.trim() !== ""
            ? outcome.reason
            : "The cloud rejected this mark.",
      };
    }

    await recordUploadResult(mark.queueId, result);
    if (result.outcome === "SENT") {
      summary.accepted += 1;
    } else if (result.outcome === "REJECTED") {
      summary.rejected += 1;
    } else {
      summary.deferred += 1;
    }
  }

  return summary;
}