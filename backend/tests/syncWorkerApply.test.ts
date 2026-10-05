// MUST be the first import: it sets SYNC_PROVIDER_SECRET_HASH in the environment
// before `config/sync` is evaluated, so the edge credential tests can exercise
// both an accepted and a rejected credential against the real endpoint.
import { TEST_EDGE_SECRET } from "./syncTestFixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { syncConfig } from "../src/config/sync";
import {
  SyncApplyError,
  applyChangeBatch,
  readCursor,
} from "../src/services/syncApplyService";
import { SyncFeedError, fetchChangeBatch } from "../src/services/syncFeedClient";
import {
  computeBackoffDelayMs,
  isSyncWorkerRunning,
  runSyncOnce,
  startSyncWorker,
  stopSyncWorker,
} from "../src/services/syncWorker";
import {
  getSyncStatus,
  recordSyncFailure,
  resetSyncStatusForTests,
} from "../src/services/syncStatusStore";
import type { SyncChangeEvent, SyncOperation } from "../src/types/sync";

const CONSUMER_ID = "local-test-edge";

/**
 * Insert events straight into the feed so the apply tests do not depend on the
 * attendance-session lifecycle. The returned cursors are real, so contiguity
 * assertions are meaningful.
 */
async function seedFeedEvents(
  count: number,
  options: {
    operation?: SyncOperation;
    /** Reuse an existing sync id to model the CREATED -> CLOSED pair for one session. */
    syncId?: string;
    status?: "ACTIVE" | "ENDED";
    endedAt?: string | null;
  } = {}
): Promise<SyncChangeEvent[]> {
  const events: SyncChangeEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const syncId = options.syncId ?? randomUUID();
    const operation = options.operation ?? "CREATED";
    const status = options.status ?? (operation === "CLOSED" ? "ENDED" : "ACTIVE");
    const payload = {
      syncId,
      cloudSessionId: 1000 + index,
      cloudCourseOfferingId: 7,
      cloudLecturerId: 3,
      courseCode: "SYNC 101",
      courseTitle: "Synchronization Fundamentals",
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3_600_000).toISOString(),
      lateThresholdMinutes: 5,
      status,
      endedAt:
        options.endedAt !== undefined
          ? options.endedAt
          : status === "ENDED"
            ? new Date().toISOString()
            : null,
    };

    const inserted = await pool.query(
      `INSERT INTO sync_change_events
         (event_id, entity_type, entity_id, operation, payload)
       VALUES ($1, 'attendance_session', $2, $3, $4::jsonb)
       RETURNING cursor, event_id, recorded_at`,
      [randomUUID(), syncId, operation, JSON.stringify({ version: 1, session: payload })]
    );

    const row = inserted.rows[0];
    events.push({
      eventId: row.event_id,
      cursor: Number(row.cursor),
      entityType: "attendance_session",
      entityId: syncId,
      operation,
      payload,
      recordedAt: row.recorded_at.toISOString(),
    });
  }
  return events;
}

/** Point the edge cursor just before the supplied events so they are contiguous. */
async function setCursorBefore(events: SyncChangeEvent[]): Promise<void> {
  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
     VALUES ($1, $2)
     ON CONFLICT (consumer_id) DO UPDATE SET last_cursor = EXCLUDED.last_cursor`,
    [CONSUMER_ID, events[0].cursor - 1]
  );
}

async function storedSessions() {
  const result = await pool.query(
    `SELECT cloud_sync_id, status, ended_at, source_event_cursor, course_code
     FROM sync_attendance_sessions ORDER BY cloud_session_id`
  );
  return result.rows;
}

async function storedReceipts() {
  const result = await pool.query(
    `SELECT event_id, cursor FROM sync_processed_events WHERE consumer_id = $1 ORDER BY cursor`,
    [CONSUMER_ID]
  );
  return result.rows;
}

before(async () => {
  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor) VALUES ($1, 0)
     ON CONFLICT (consumer_id) DO NOTHING`,
    [CONSUMER_ID]
  );
});

after(async () => {
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [CONSUMER_ID]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id = $1`, [CONSUMER_ID]);
  await pool.query(`DELETE FROM sync_attendance_sessions`);
  await pool.query(
    `DELETE FROM sync_change_events WHERE payload->'session'->>'courseCode' = 'SYNC 101'`
  );
  await pool.end();
});

beforeEach(async () => {
  resetSyncStatusForTests();
  // The edge tables are shared by every test in this file, so they are reset per
  // test rather than only at the end. The cloud feed itself is intentionally NOT
  // cleared: its cursors keep growing, which is what makes `setCursorBefore` a
  // meaningful way to position the edge.
  await pool.query(`DELETE FROM sync_attendance_sessions`);
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [CONSUMER_ID]);
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = 0 WHERE consumer_id = $1`,
    [CONSUMER_ID]
  );
});

// ---------------------------------------------------------------------------
// Local application
// ---------------------------------------------------------------------------

test("a first batch applies and advances the cursor", async () => {
  const events = await seedFeedEvents(3);
  await setCursorBefore(events);

  const result = await applyChangeBatch(CONSUMER_ID, events);

  assert.equal(result.applied, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.cursor, events[2].cursor);
  assert.equal(await readCursor(CONSUMER_ID), events[2].cursor);

  const sessions = await storedSessions();
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].course_code, "SYNC 101");
  // `source_event_cursor` is BIGINT, which `pg` returns as a string.
  assert.equal(Number(sessions[0].source_event_cursor), events[0].cursor);

  assert.equal((await storedReceipts()).length, 3);
});

test("an empty batch is a no-op that leaves the cursor alone", async () => {
  const events = await seedFeedEvents(1);
  await setCursorBefore(events);
  await applyChangeBatch(CONSUMER_ID, events);
  const cursorBefore = await readCursor(CONSUMER_ID);

  const result = await applyChangeBatch(CONSUMER_ID, []);

  assert.equal(result.applied, 0);
  assert.equal(result.cursor, cursorBefore);
});

test("a later CLOSED event overwrites the local copy rather than duplicating it", async () => {
  const syncId = randomUUID();

  const created = await seedFeedEvents(1, { syncId, operation: "CREATED", status: "ACTIVE", endedAt: null });
  await setCursorBefore(created);
  await applyChangeBatch(CONSUMER_ID, created);
  assert.equal((await storedSessions()).length, 1);

  // Same sync id, new event: the edge must recognise it as an update, not a new
  // session.
  const closed = await seedFeedEvents(1, {
    syncId,
    operation: "CLOSED",
    status: "ENDED",
    endedAt: new Date().toISOString(),
  });
  await applyChangeBatch(CONSUMER_ID, closed);

  const sessions = await storedSessions();
  assert.equal(sessions.length, 1, "closure must not create a second row");
  assert.equal(sessions[0].status, "ENDED");
  assert.ok(sessions[0].ended_at);
  assert.equal(Number(sessions[0].source_event_cursor), closed[0].cursor);
});

test("a failure during application rolls back the events, the receipts and the cursor", async () => {
  const good = await seedFeedEvents(2);
  await setCursorBefore(good);
  const cursorBefore = await readCursor(CONSUMER_ID);

  // The second event violates a NOT NULL column. `assertUsableSession` does not
  // check courseCode, so this fails INSIDE the transaction - which is the case
  // that proves the rollback covers a partially applied batch.
  const broken: SyncChangeEvent = {
    ...good[1],
    payload: { ...good[1].payload, courseCode: null as unknown as string },
  };

  await assert.rejects(
    () => applyChangeBatch(CONSUMER_ID, [good[0], broken]),
    /sync_attendance_sessions|violates not-null/
  );

  assert.equal(
    await readCursor(CONSUMER_ID),
    cursorBefore,
    "a failed batch must not advance the cursor"
  );

  // The first event of the failed batch must not be left applied.
  const appliedFirst = await pool.query(
    `SELECT 1 FROM sync_attendance_sessions WHERE cloud_sync_id = $1`,
    [good[0].entityId]
  );
  assert.equal(
    appliedFirst.rowCount,
    0,
    "the first event of a rolled-back batch must not remain applied"
  );

  const receipt = await pool.query(
    `SELECT 1 FROM sync_processed_events WHERE consumer_id = $1 AND event_id = $2`,
    [CONSUMER_ID, good[0].eventId]
  );
  assert.equal(receipt.rowCount, 0, "receipts must roll back with the batch");
});

test("re-delivering the same events is idempotent", async () => {
  const events = await seedFeedEvents(3);
  await setCursorBefore(events);

  const first = await applyChangeBatch(CONSUMER_ID, events);
  assert.equal(first.applied, 3);
  const sessionsAfterFirst = await storedSessions();

  // Rewind the cursor to replay exactly the same events, as a lost response or a
  // restart would cause.
  await pool.query(
    `UPDATE sync_consumer_state SET last_cursor = $2 WHERE consumer_id = $1`,
    [CONSUMER_ID, events[0].cursor - 1]
  );

  const replay = await applyChangeBatch(CONSUMER_ID, events);
  assert.equal(replay.applied, 0);
  assert.equal(replay.skipped, 3, "every event should be recognised as already processed");

  const sessionsAfterReplay = await storedSessions();
  assert.equal(sessionsAfterReplay.length, sessionsAfterFirst.length, "no duplicate sessions");
  assert.deepEqual(
    sessionsAfterReplay.map((row) => row.cloud_sync_id).sort(),
    sessionsAfterFirst.map((row) => row.cloud_sync_id).sort()
  );
  assert.equal((await storedReceipts()).length, 3, "no duplicate receipts");
});

test("a cursor gap is refused rather than silently skipped", async () => {
  const events = await seedFeedEvents(3);
  await setCursorBefore(events);
  await applyChangeBatch(CONSUMER_ID, events);
  const cursorAfter = await readCursor(CONSUMER_ID);

  // A batch that starts past the cursor. Constructed rather than seeded, because
  // inserting a fresh event always produces a contiguous cursor by definition -
  // a real gap means an event was lost upstream, which cannot be simulated by
  // appending.
  const skippedCursor = cursorAfter + 5;
  const gapped: SyncChangeEvent = {
    ...events[0],
    eventId: randomUUID(),
    cursor: skippedCursor,
    entityId: randomUUID(),
    payload: { ...events[0].payload, syncId: randomUUID() },
  };

  await assert.rejects(
    () => applyChangeBatch(CONSUMER_ID, [gapped]),
    (error: unknown) => {
      assert.ok(error instanceof SyncApplyError);
      assert.match((error as Error).message, /Cursor gap/);
      return true;
    }
  );

  assert.equal(
    await readCursor(CONSUMER_ID),
    cursorAfter,
    "a gap must leave the cursor untouched"
  );
});

test("out-of-order and backwards batches are refused", async () => {
  const events = await seedFeedEvents(2);
  await setCursorBefore(events);

  await assert.rejects(
    () => applyChangeBatch(CONSUMER_ID, [events[1], events[0]]),
    /went backwards|Cursor gap/
  );

  assert.equal(await readCursor(CONSUMER_ID), events[0].cursor - 1);
});

test("an unsupported entity type blocks the cursor instead of being skipped", async () => {
  const events = await seedFeedEvents(1);
  await setCursorBefore(events);

  const foreign: SyncChangeEvent = {
    ...events[0],
    entityType: "course" as SyncChangeEvent["entityType"],
  };

  await assert.rejects(
    () => applyChangeBatch(CONSUMER_ID, [foreign]),
    /Unsupported sync entity type/
  );
  assert.equal(await readCursor(CONSUMER_ID), events[0].cursor - 1);
});

test("a restarted worker resumes from the stored cursor", async () => {
  const events = await seedFeedEvents(4);
  await setCursorBefore(events);

  await applyChangeBatch(CONSUMER_ID, events.slice(0, 2));
  const resumed = await readCursor(CONSUMER_ID);
  assert.equal(resumed, events[1].cursor, "cursor persisted across calls");

  // A fresh "worker" instance reads only the durable cursor.
  await applyChangeBatch(CONSUMER_ID, events.slice(2));
  assert.equal(await readCursor(CONSUMER_ID), events[3].cursor);

  const sessions = await storedSessions();
  assert.ok(
    sessions.some((row) => Number(row.source_event_cursor) === events[3].cursor),
    "the resumed batch was applied"
  );
});

// ---------------------------------------------------------------------------
// Retry behaviour and startup independence
// ---------------------------------------------------------------------------

test("an unreachable cloud produces a retryable error, not a crash", async () => {
  // Port 1 is reserved and refuses connections, standing in for an offline
  // cloud or a severed Internet link.
  await assert.rejects(
    () =>
      fetchChangeBatch(0, 10, {
        enabled: true,
        consumerId: CONSUMER_ID,
        // Reserved-for-testing port: connections are refused.
        cloudBaseUrl: "http://127.0.0.1:1",
        edgeSecret: "irrelevant",
        intervalMs: 1000,
        batchLimit: 10,
        requestTimeoutMs: 1000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SyncFeedError);
      assert.equal(error.retryable, true, "a network failure must be retryable");
      return true;
    }
  );
});

test("an authentication failure is not retryable, a success is", async () => {
  // The credential fixture must be imported before the app so the provider hash
  // is configured for TEST_EDGE_SECRET.
  const { app } = await import("../src/app");

  const listener = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const port = (listener.address() as AddressInfo).port;

  const base = (secret: string) => ({
    enabled: true,
    consumerId: CONSUMER_ID,
    cloudBaseUrl: `http://127.0.0.1:${port}`,
    edgeSecret: secret,
    intervalMs: 1000,
    batchLimit: 10,
    requestTimeoutMs: 2000,
  });

  try {
    await assert.rejects(
      () => fetchChangeBatch(0, 10, base("wrong-secret")),
      (error: unknown) => {
        assert.ok(error instanceof SyncFeedError);
        assert.equal(error.retryable, false, "HTTP 401 must not be retried");
        assert.match((error as Error).message, /401/);
        return true;
      }
    );

    // The correct credential is accepted and returns a usable page.
    const batch = await fetchChangeBatch(0, 10, base(TEST_EDGE_SECRET));
    assert.ok(Array.isArray(batch.events));
    assert.equal(typeof batch.nextCursor, "number");
  } finally {
    // `fetch` keeps sockets alive and `close()` waits for them, which hangs the
    // runner; drop them first.
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("backoff grows to a bounded cap and never busy-loops", () => {
  assert.equal(computeBackoffDelayMs(0), 0);
  assert.equal(computeBackoffDelayMs(1), 2_000);
  assert.equal(computeBackoffDelayMs(2), 5_000);
  assert.equal(computeBackoffDelayMs(3), 10_000);
  assert.equal(computeBackoffDelayMs(4), 30_000);
  assert.equal(computeBackoffDelayMs(5), 60_000);
  assert.equal(computeBackoffDelayMs(50), 60_000, "backoff must be capped");
});

/**
 * Regression test for the busy-loop bug: `runSyncOnce` recorded failures but the
 * worker's own drain loop did not, so the failure counter stayed at 0 and the
 * next delay computed as 0ms. A single unreachable cloud therefore meant a
 * continuous 0ms retry loop.
 */
test("a real fetch failure is counted, so the next delay is a backoff not zero", async () => {
  // Port 1 is not listening, so this fails at connect rather than depending on DNS.
  const config = {
    enabled: true,
    consumerId: CONSUMER_ID,
    cloudBaseUrl: "http://127.0.0.1:1",
    edgeSecret: TEST_EDGE_SECRET,
    intervalMs: 1_000,
    batchLimit: 10,
    requestTimeoutMs: 300,
  };

  resetSyncStatusForTests();
  await assert.rejects(() => runSyncOnce(config));

  const afterFailure = getSyncStatus();
  assert.ok(
    afterFailure.consecutiveFailures >= 1,
    "a failed attempt must increment the consecutive-failure counter, otherwise the worker retries in a 0ms loop"
  );
  assert.ok(afterFailure.lastErrorMessage, "the failure must be reported in status");
  assert.ok(
    computeBackoffDelayMs(afterFailure.consecutiveFailures) > 0,
    "the delay after a failure must be strictly positive"
  );
  assert.equal(await readCursor(CONSUMER_ID), 0, "a failure must not move the cursor");

  // A second failure climbs the schedule, and the cursor still has not moved.
  await assert.rejects(() => runSyncOnce(config));
  assert.ok(getSyncStatus().consecutiveFailures >= 2);
  assert.ok(computeBackoffDelayMs(getSyncStatus().consecutiveFailures) > 2_000);
});

/**
 * A rejected event must count as a failure too, otherwise an upstream data
 * problem retries at full speed forever without ever appearing in the log.
 *
 * This drives the worker's real path against a stub feed that serves one event
 * the edge cannot understand, which is the case that must stop the cursor.
 */
test("a rejected batch is counted as a failure and leaves the cursor alone", async () => {
  const events = await seedFeedEvents(1);
  await setCursorBefore(events);
  const cursorBefore = await readCursor(CONSUMER_ID);

  const stubEvent: SyncChangeEvent = {
    ...events[0],
    eventId: randomUUID(),
    entityType: "some_entity_this_edge_does_not_know",
    entityId: randomUUID(),
  };

  const listener = await new Promise<Server>((resolve) => {
    const started = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            events: [stubEvent],
            nextCursor: stubEvent.cursor,
            hasMore: false,
          },
        })
      );
    });
    started.listen(0, "127.0.0.1", () => resolve(started));
  });
  const port = (listener.address() as AddressInfo).port;

  try {
    resetSyncStatusForTests();
    await assert.rejects(() =>
      runSyncOnce({
        enabled: true,
        consumerId: CONSUMER_ID,
        cloudBaseUrl: `http://127.0.0.1:${port}`,
        edgeSecret: TEST_EDGE_SECRET,
        intervalMs: 1_000,
        batchLimit: 10,
        requestTimeoutMs: 2_000,
      })
    );

    assert.ok(
      getSyncStatus().consecutiveFailures >= 1,
      "an unapplicable batch must be counted as a failure"
    );
    assert.ok(getSyncStatus().lastErrorMessage);
    assert.equal(
      await readCursor(CONSUMER_ID),
      cursorBefore,
      "an unknown entity type must not advance the cursor"
    );
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("failures are counted and cleared, and no secret is recorded in status", () => {
  recordSyncFailure("something went wrong");
  recordSyncFailure("still wrong");

  let status = getSyncStatus();
  assert.equal(status.consecutiveFailures, 2);
  assert.equal(status.lastErrorMessage, "still wrong");

  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("edgeSecret"));
  assert.ok(!serialized.includes("SYNC_EDGE_SECRET"));

  status = { ...status, consecutiveFailures: 0 };
  assert.equal(status.consecutiveFailures, 0);
});

test("the worker is disabled by default, so a normal backend starts with no cloud configured", () => {
  assert.equal(syncConfig.consumer.enabled, false, "sync must be opt-in");

  startSyncWorker();
  assert.equal(isSyncWorkerRunning(), false, "a disabled worker must not start");
  assert.equal(getSyncStatus().enabled, false);

  stopSyncWorker();
  assert.equal(isSyncWorkerRunning(), false);
});

test("the local server still serves requests with no cloud reachable", async () => {
  // Proves the ordering requirement: the worker is started after the listener and
  // is never awaited, so cloud reachability cannot gate application startup.
  const { app } = await import("../src/app");
  const listener = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const port = (listener.address() as AddressInfo).port;

  try {
    startSyncWorker();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);

    const body = (await health.json()) as { status: string };
    assert.equal(body.status, "ok");
  } finally {
    stopSyncWorker();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});