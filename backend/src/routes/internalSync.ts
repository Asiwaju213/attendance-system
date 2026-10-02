import { Request, Response, Router } from "express";
import { syncConfig } from "../config/sync";
import { requireEdgeSyncAuth } from "../middleware/edgeSyncAuth";
import {
  DEFAULT_CHANGE_FEED_LIMIT,
  MAX_CHANGE_FEED_LIMIT,
  listChangeEventsSince,
} from "../services/syncChangeEventStore";
import {
  applyInboundAttendanceMarks,
  type InboundAttendanceMark,
  type InboundMarkStatus,
} from "../services/syncInboundAttendanceStore";
import { getSyncStatus } from "../services/syncStatusStore";

/**
 * Internal edge -> cloud synchronization API.
 *
 * This is not a general-purpose API and must never grow into one. It exposes
 * exactly two operations, both required by the design and neither generalisable:
 *
 *   1. "give me the feed after this cursor" - master data flowing outward, cloud
 *      to edge (Task 1/2). Read-only.
 *   2. "record these attendance marks" - attendance flowing inward, edge to cloud
 *      (Task 4). A command, not a state mirror, and the cloud's canonical record is
 *      what ends up written.
 *
 * There is no entity lookup by id, no arbitrary table read, and no way to pass a
 * query, a filter or a table name through to the database layer. Every statement in
 * the services it calls has a fixed shape with bound parameters, and each endpoint
 * reads only the named fields of its own fixed request shape.
 *
 * Mounted under /api/internal, outside every role router, and guarded by
 * `requireEdgeSyncAuth` rather than `requireAuth` so no user session can reach it.
 */

const router = Router();

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

/**
 * Parse the `cursor` query parameter.
 *
 * Absent means "from the beginning of the feed", which is 0 rather than NULL so
 * it maps directly onto `WHERE cursor > $1`.
 *
 * The value must be a non-negative integer. Anything else is rejected instead of
 * being coerced, because a cursor that is silently reinterpreted as 0 would make
 * the edge re-read the entire feed and a negative or fractional cursor has no
 * meaning at all.
 */
function parseCursor(raw: unknown): number | null {
  if (raw === undefined) {
    return 0;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Parse the `limit` query parameter, clamped into a hard range.
 *
 * Clamping rather than rejecting an oversized limit is intentional: the point of
 * the ceiling is that the provider decides the maximum page size, and clamping
 * lets a client asking for too much still make forward progress instead of
 * getting stuck on a 400. A non-numeric limit is rejected.
 */
function parseLimit(raw: unknown, fallback: number): number | null {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    return null;
  }
  return Math.min(value, MAX_CHANGE_FEED_LIMIT);
}

/**
 * GET /api/internal/sync/changes?cursor=<cursor>&limit=<limit>
 *
 * Returns an ordered, bounded page of the change feed strictly after `cursor`.
 * Responses are always in ascending cursor order, which is the ordering contract
 * the edge applies them in.
 */
router.get("/changes", requireEdgeSyncAuth, async (req: Request, res: Response) => {
  const cursor = parseCursor(req.query.cursor);
  if (cursor === null) {
    sendInvalidRequest(
      res,
      "The cursor query parameter must be a non-negative integer."
    );
    return;
  }

  const limit = parseLimit(req.query.limit, syncConfig.provider.batchLimit);
  if (limit === null) {
    sendInvalidRequest(
      res,
      "The limit query parameter must be a positive integer."
    );
    return;
  }

  try {
    const batch = await listChangeEventsSince(cursor, limit);
    res.status(200).json({ data: batch });
  } catch (error) {
    // The error message is logged, not returned: a database error must not
    // become a description of the feed's internals for an unauthenticated
    // prober (the request is authenticated here, but the principle is kept
    // uniform with the rest of the API).
    console.error("Sync feed read failed.", (error as Error).message);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
  }
});

/**
 * POST /api/internal/sync/attendance-marks
 *
 * The upload half of Task 4: the edge sends the marks it has recorded, and the
 * cloud writes them as the canonical attendance records.
 *
 * The response reports a per-mark ACCEPTED/REJECTED outcome rather than one status
 * for the whole batch. This is what lets the edge retire the marks that landed and
 * keep only the ones that actually need attention: a batch containing one
 * unresolvable session must not leave the other fifty marks queued forever.
 *
 * Behind the same edge credential as the feed. No user session can reach it, and no
 * request shape can turn it into a general write API: only the fields below are
 * read, and every statement in the receiving service has a fixed shape.
 */

const MAX_ATTENDANCE_MARK_BATCH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one mark's exact field set.
 *
 * Every field is required and typed, and unknown fields are ignored rather than
 * rejected, because this endpoint may be extended later and an older edge must not
 * start failing its uploads against a newer cloud. UUIDs are format-checked here so
 * an obviously malformed request is a clean 400 instead of a database error raised
 * deep inside the service.
 */
function parseInboundMark(raw: unknown): InboundAttendanceMark | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { queueId, sessionSyncId, matricNumber, status, markedAt } = raw;
  if (
    typeof queueId !== "string" ||
    !UUID_PATTERN.test(queueId) ||
    typeof sessionSyncId !== "string" ||
    !UUID_PATTERN.test(sessionSyncId) ||
    typeof matricNumber !== "string" ||
    matricNumber.trim() === "" ||
    typeof status !== "string" ||
    (status !== "PRESENT" && status !== "LATE") ||
    typeof markedAt !== "string" ||
    Number.isNaN(Date.parse(markedAt))
  ) {
    return null;
  }
  return {
    queueId,
    sessionSyncId,
    matricNumber: matricNumber.trim(),
    status: status as InboundMarkStatus,
    markedAt,
  };
}

router.post(
  "/attendance-marks",
  requireEdgeSyncAuth,
  async (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (!isRecord(body) || !Array.isArray(body.marks)) {
      sendInvalidRequest(res, "The request body must contain a marks array.");
      return;
    }
    if (body.marks.length > MAX_ATTENDANCE_MARK_BATCH) {
      sendInvalidRequest(
        res,
        `A batch may contain at most ${MAX_ATTENDANCE_MARK_BATCH} marks.`
      );
      return;
    }

    const marks: InboundAttendanceMark[] = [];
    for (const raw of body.marks) {
      const mark = parseInboundMark(raw);
      if (mark === null) {
        sendInvalidRequest(
          res,
          "Every mark must provide a queueId, sessionSyncId, matricNumber, status " +
            "(PRESENT or LATE) and a parseable markedAt timestamp."
        );
        return;
      }
      marks.push(mark);
    }

    try {
      const outcomes = await applyInboundAttendanceMarks(marks);
      res.status(200).json({ data: outcomes });
    } catch (error) {
      console.error(
        "Inbound attendance upload failed.",
        (error as Error).message
      );
      // 500, not 400: the batch was well-formed, so this is the cloud failing to
      // record it. A 500 is what makes the edge retry rather than park the marks.
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "The attendance marks could not be recorded.",
      });
    }
  }
);

/**
 * GET /api/internal/sync/status
 *
 * The worker's observable state: last durable cursor, last success, last attempt,
 * current error and whether it is enabled and running. Behind the same edge
 * credential as the feed rather than open, because it names the configured edge
 * and its position in the cloud's feed.
 *
 * The payload is built from a fixed status shape that contains no credential and
 * no cloud base URL, so serving it cannot leak anything that matters.
 */
router.get("/status", requireEdgeSyncAuth, (_req: Request, res: Response) => {
  res.status(200).json({ data: getSyncStatus() });
});

// Exported for tests and documentation so the default page size is not duplicated
// as a magic number at a call site.
export { DEFAULT_CHANGE_FEED_LIMIT };

export default router;