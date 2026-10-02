import { Request, Response, Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/authenticate";
import {
  getSyncHealth,
  listRejectedAttendanceMarks,
} from "../services/syncHealthStore";
import { requeueRejectedMark } from "../services/syncOutboundQueueStore";

/**
 * Administrative synchronization health (Task 6).
 *
 * The point of this router is that a K12 operator does not need a shell on the PC to
 * find out whether their attendance data is safe. Everything it exposes is
 * derived from the worker's own state and the outbound queue, so it cannot drift
 * from reality.
 *
 * `requireAuth, requireAdmin` is applied to the whole router rather than per route,
 * and it is the ordinary user-session authorization - not `requireEdgeSyncAuth`.
 * That distinction matters: the edge credential is a machine credential held by one
 * PC, so anything an operator needs to see or act on has to be reachable by a human
 * who signs in as an admin. It also means a student or lecturer session can never
 * read sync health or a rejection reason, both of which can name attendance data.
 */

const router = Router();

router.use(requireAuth, requireAdmin);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Number(raw.trim()), MAX_LIMIT);
}

function sendServerError(res: Response, context: string, error: unknown): void {
  console.error(`${context}`, (error as Error).message);
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
  });
}

/**
 * GET /api/admin/sync-status
 *
 * Both directions at once: the inbound worker's cursor and health, and the outbound
 * queue's depth, age and rejections, with an overall verdict.
 *
 * Safe to poll. Every read is an indexed aggregate or an in-memory field, so a
 * dashboard refreshing this cannot add load that competes with student requests.
 */
router.get("/sync-status", async (_req: Request, res: Response) => {
  try {
    const health = await getSyncHealth();
    res.status(200).json({ data: health });
  } catch (error) {
    sendServerError(res, "Sync health read failed.", error);
  }
});

/**
 * GET /api/admin/sync-rejected-marks?limit=<limit>
 *
 * The attendance marks the cloud refused, newest first. This is the actionable half
 * of the health snapshot: each row names a student and a session, so it is served
 * under admin authorization and never through the edge-credential endpoint.
 */
router.get("/sync-rejected-marks", async (req: Request, res: Response) => {
  try {
    const marks = await listRejectedAttendanceMarks(parseLimit(req.query.limit));
    res.status(200).json({ data: marks });
  } catch (error) {
    sendServerError(res, "Rejected attendance mark read failed.", error);
  }
});

/**
 * POST /api/admin/sync-rejected-marks/:queueId/requeue
 *
 * Return one rejected mark to the queue after the reason it was refused has been
 * fixed - typically an enrolment or a session the cloud did not have yet.
 *
 * Returns 404 rather than 400 when the row is not currently REJECTED, because the
 * common case is not a malformed request but an operator acting on a stale list: the
 * mark may already have been requeued by hand. Re-queueing is deliberately a
 * one-row-at-a-time, explicit action; there is no bulk variant, because a bulk
 * requeue would re-send every parked mark at once against a cause that has usually
 * not been fixed.
 */
router.post(
  "/sync-rejected-marks/:queueId/requeue",
  async (req: Request, res: Response) => {
    // A repeated :queueId arrives as an array; treat that as malformed rather than
    // coercing it, since there is no meaningful choice between two ids.
    const rawQueueId: unknown = req.params.queueId;
    const queueId = typeof rawQueueId === "string" ? rawQueueId.trim() : null;
    if (queueId === null || queueId === "") {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "A queue id is required.",
      });
      return;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        queueId
      )
    ) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "The queue id must be a UUID.",
      });
      return;
    }

    try {
      const requeued = await requeueRejectedMark(queueId);
      if (!requeued) {
        res.status(404).json({
          error: "NOT_REJECTED",
          message:
            "No rejected attendance mark with that queue id is waiting to be requeued.",
        });
        return;
      }
      res.status(200).json({ data: { queueId, status: "PENDING" } });
    } catch (error) {
      sendServerError(res, "Rejected mark requeue failed.", error);
    }
  }
);

export default router;