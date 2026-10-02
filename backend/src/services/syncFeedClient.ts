import { syncConfig } from "../config/sync";
import type { SyncChangeEvent, SyncChangesBatch } from "../types/sync";
import { SyncFeedError } from "./syncErrors";

export { SyncFeedError };

/**
 * The edge's client for the cloud change feed.
 *
 * Deliberately dumb: it performs one authenticated GET and returns the parsed
 * batch. It holds no cursor, applies nothing and retries nothing - that is the
 * apply service's and the worker's job. Keeping the transport separate from the
 * transaction is what makes the apply logic testable without a network and the
 * worker testable without an HTTP server.
 */

/**
 * A structured failure the worker can distinguish from a generic bug.
 *
 * Re-exported from `syncErrors` so existing importers of this module keep
 * working. It lives in `syncErrors` because the cloud-side feed store also raises
 * it, and importing it from here would make the two modules depend on each other.
 */

function isSyncChangeEvent(value: unknown): value is SyncChangeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SyncChangeEvent>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.cursor === "number" &&
    typeof candidate.entityType === "string" &&
    typeof candidate.entityId === "string" &&
    typeof candidate.operation === "string" &&
    typeof candidate.recordedAt === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/**
 * Send one batch of attendance marks to the cloud (Task 4).
 *
 * The POST counterpart to `fetchChangeBatch`, and kept here for the same reason:
 * the credential, the base URL and the timeout are transport concerns, and the
 * uploader that decides *what* a mark's outcome means should not have to know how
 * an authenticated request is made.
 *
 * Returns the raw per-mark outcome array for the caller to interpret. It throws
 * `SyncFeedError` only when the REQUEST as a whole failed, because that is the only
 * case where the edge must not advance any row's state.
 *
 * A 4xx is treated as retryable here on purpose, unlike in `fetchChangeBatch`. The
 * reason is that the marks are attendance data: a rejected upload must leave every
 * mark in the queue where Task 6 can show it, not be discarded. Parking a mark for
 * a human is recoverable; losing it is not.
 */
export async function postAttendanceMarkBatch(
  marks: ReadonlyArray<Record<string, unknown>>,
  config = syncConfig.consumer
): Promise<unknown[]> {
  const url = `${config.cloudBaseUrl}/api/internal/sync/attendance-marks`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.edgeSecret}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ marks }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new SyncFeedError(
      `Cloud attendance upload unreachable: ${(error as Error).message}`,
      true
    );
  }

  if (!response.ok) {
    throw new SyncFeedError(
      `Cloud attendance upload returned HTTP ${response.status}.`,
      response.status !== 400
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SyncFeedError(
      "Cloud attendance upload returned a body that was not JSON.",
      true
    );
  }

  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new SyncFeedError(
      "Cloud attendance upload returned an unexpected payload shape.",
      true
    );
  }
  return data;
}

/**
 * Fetch one ordered page of the feed strictly after `cursor`.
 *
 * Throws `SyncFeedError` for anything that prevented a trustworthy page from
 * being read. It never returns a partially-valid batch: a response that does not
 * match the expected shape is an error, because applying a half-understood batch
 * is exactly the failure the cursor model exists to prevent.
 */
export async function fetchChangeBatch(
  cursor: number,
  limit: number,
  config = syncConfig.consumer
): Promise<SyncChangesBatch> {
  const url = `${config.cloudBaseUrl}/api/internal/sync/changes?cursor=${encodeURIComponent(
    String(cursor)
  )}&limit=${encodeURIComponent(String(limit))}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        // The edge credential is a server-side secret and appears only here, in a
        // request header, never in a URL, a log line, or any browser-facing code.
        authorization: `Bearer ${config.edgeSecret}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    // Timeouts, DNS failures, refused connections and TLS problems all land
    // here. All of them are worth retrying, because none of them are caused by
    // the request's contents.
    throw new SyncFeedError(
      `Cloud sync feed unreachable: ${(error as Error).message}`,
      true
    );
  }

  if (!response.ok) {
    // 401/403 will never start working by retrying: the credential is wrong.
    const retryable = response.status >= 500 || response.status === 429;
    throw new SyncFeedError(
      `Cloud sync feed returned HTTP ${response.status}.`,
      retryable
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SyncFeedError(
      "Cloud sync feed returned a body that was not JSON.",
      true
    );
  }

  const data = (body as { data?: unknown })?.data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    !Array.isArray((data as SyncChangesBatch).events) ||
    typeof (data as SyncChangesBatch).nextCursor !== "number"
  ) {
    throw new SyncFeedError(
      "Cloud sync feed returned an unexpected payload shape.",
      true
    );
  }

  const batch = data as SyncChangesBatch;
  if (!batch.events.every(isSyncChangeEvent)) {
    throw new SyncFeedError(
      "Cloud sync feed returned a malformed change event.",
      true
    );
  }

  return {
    events: batch.events,
    nextCursor: batch.nextCursor,
    hasMore: typeof batch.hasMore === "boolean" ? batch.hasMore : false,
  };
}