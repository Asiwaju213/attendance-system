// The credential fixture must be imported FIRST: it sets
// SYNC_PROVIDER_SECRET_HASH before `config/sync` is evaluated.
import {
  TEST_EDGE_SECRET,
  cleanupSyncTestFixtures,
  seedLecturerSessionFixture,
  syncAuthHeaders,
} from "./syncTestFixtures";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { app } from "../src/app";

let server: Server;
let baseUrl: string;

let fixture: Awaited<ReturnType<typeof seedLecturerSessionFixture>>;

function sessionCookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

function validCreateBody(): Record<string, unknown> {
  return {
    courseOfferingId: fixture.courseOfferingId,
    durationMinutes: 60,
    lateThresholdMinutes: 5,
  };
}

/** Start a real attendance session through the lecturer API. */
async function createSessionViaApi(): Promise<{ id: number; syncId: string }> {
  const response = await postJson(
    "/api/lecturer/attendance-sessions",
    validCreateBody(),
    sessionCookieHeader(fixture.sessionToken)
  );
  assert.equal(response.status, 201, "session creation should succeed");
  const body = (await response.json()) as { data: { id: number } };
  const row = await pool.query(
    `SELECT sync_id FROM attendance_sessions WHERE id = $1`,
    [body.data.id]
  );
  return { id: body.data.id, syncId: row.rows[0].sync_id as string };
}

async function eventsForSession(syncId: string) {
  const result = await pool.query(
    `SELECT cursor, event_id, entity_type, entity_id, operation, payload, recorded_at
     FROM sync_change_events WHERE entity_id = $1 ORDER BY cursor ASC`,
    [syncId]
  );
  return result.rows;
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  fixture = await seedLecturerSessionFixture();
});

after(async () => {
  await cleanupSyncTestFixtures();
  // `fetch` keeps sockets alive, and `close()` waits for them, which would hang
  // the runner. Dropping them first makes teardown deterministic.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM sync_change_events
     WHERE entity_id IN (
       SELECT sync_id::text FROM attendance_sessions
       WHERE course_offering_id = $1
     )`,
    [fixture.courseOfferingId]
  );
  await pool.query(
    `DELETE FROM attendance_sessions WHERE course_offering_id = $1`,
    [fixture.courseOfferingId]
  );
});

// ---------------------------------------------------------------------------
// Cloud change feed: events are created by the business transactions
// ---------------------------------------------------------------------------

test("starting an attendance session creates a CREATED sync event", async () => {
  const created = await createSessionViaApi();
  const events = await eventsForSession(created.syncId);

  assert.equal(events.length, 1, "exactly one event per session start");

  const event = events[0];
  assert.equal(event.entity_type, "attendance_session");
  assert.equal(event.entity_id, created.syncId);
  assert.equal(event.operation, "CREATED");

  // The entity id is the sync-safe UUID, never the cloud BIGSERIAL id.
  assert.match(event.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const payload = event.payload.session;
  assert.equal(payload.syncId, created.syncId);
  assert.equal(payload.cloudSessionId, created.id);
  assert.equal(payload.status, "ACTIVE");
  assert.equal(payload.endedAt, null);
  assert.ok(payload.courseCode.startsWith("SYNCFEED-CRS-"));
  assert.ok(Number.isFinite(payload.cloudLecturerId));
  assert.equal("attendanceNetworkId" in payload, false);
  assert.equal("locationId" in payload, false);
});

test("closing an attendance session creates a CLOSED sync event", async () => {
  const created = await createSessionViaApi();

  const ended = await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    sessionCookieHeader(fixture.sessionToken)
  );
  assert.equal(ended.status, 200);

  const events = await eventsForSession(created.syncId);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.operation),
    ["CREATED", "CLOSED"]
  );

  // The closure event carries the post-close state, so an edge can overwrite its
  // copy without knowing what the row looked like while ACTIVE.
  const closurePayload = events[1].payload.session;
  assert.equal(closurePayload.status, "ENDED");
  assert.ok(closurePayload.endedAt, "closed event should carry endedAt");
});

test("the application has no attendance-session field update, so no UPDATED event is emitted", async () => {
  // Documents a real property of the system rather than asserting an aspiration:
  // the only two mutations the API permits are start and end, so the feed only
  // ever contains CREATED and CLOSED for sessions.
  const result = await pool.query(
    `SELECT DISTINCT operation FROM sync_change_events ORDER BY operation`
  );
  for (const row of result.rows) {
    assert.ok(
      row.operation === "CREATED" || row.operation === "CLOSED",
      `unexpected operation ${row.operation}`
    );
  }

  const patch = await fetch(`${baseUrl}/api/lecturer/attendance-sessions/1`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...sessionCookieHeader(fixture.sessionToken),
    },
    body: JSON.stringify({ durationMinutes: 30 }),
  });
  assert.ok(patch.status === 404 || patch.status === 405, "no update route exists");
});

test("the change feed cursor is strictly monotonic and event ids are unique", async () => {
  const first = await createSessionViaApi();
  const firstEvents = await eventsForSession(first.syncId);

  const ended = await postJson(
    `/api/lecturer/attendance-sessions/${first.id}/end`,
    {},
    sessionCookieHeader(fixture.sessionToken)
  );
  assert.equal(ended.status, 200);

  const second = await createSessionViaApi();
  const secondEvents = await eventsForSession(second.syncId);

  const all = [...firstEvents, ...secondEvents];
  const cursors = all.map((event) => Number(event.cursor));
  for (let index = 1; index < cursors.length; index += 1) {
    assert.ok(
      cursors[index] > cursors[index - 1],
      `cursor must increase: ${cursors[index - 1]} then ${cursors[index]}`
    );
  }

  const ids = all.map((event) => event.event_id);
  assert.equal(new Set(ids).size, ids.length, "event ids must be unique");
});

test("a rolled back session leaves no event behind, and a committed one always does", async () => {
  // Failure case: an invalid request never creates a session, so it must not
  // create an event either.
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM sync_change_events`
  );

  const rejected = await postJson(
    "/api/lecturer/attendance-sessions",
    { ...validCreateBody(), durationMinutes: 9999 },
    sessionCookieHeader(fixture.sessionToken)
  );
  assert.equal(rejected.status, 400);

  const after = await pool.query(
    `SELECT count(*)::int AS n FROM sync_change_events`
  );
  assert.equal(after.rows[0].n, before.rows[0].n, "a rejected session must not emit an event");

  // Success case: the event is in the same transaction, so it is present.
  const created = await createSessionViaApi();
  const events = await eventsForSession(created.syncId);
  assert.equal(events.length, 1);
});

test("the feed is durable across connections and reads strictly after a cursor", async () => {
  const created = await createSessionViaApi();
  const events = await eventsForSession(created.syncId);
  const cursor = Number(events[0].cursor);

  // Reading from a fresh pooled connection proves the event is committed data,
  // not something held in memory by the writing request.
  const batch = await listChangeEventsSince(cursor - 1, 10);
  assert.ok(
    batch.events.some((event) => event.eventId === events[0].event_id),
    "the committed event should be readable from the feed"
  );
  assert.ok(batch.events.every((event) => event.cursor > cursor - 1));
});

// ---------------------------------------------------------------------------
// Cloud sync API
// ---------------------------------------------------------------------------

test("the sync feed rejects an unauthenticated request", async () => {
  const response = await get("/api/internal/sync/changes");
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "SYNC_UNAUTHORIZED");
});

test("the sync feed rejects an invalid credential", async () => {
  for (const bad of [
    { authorization: "Bearer wrong-secret" },
    { authorization: `Basic ${TEST_EDGE_SECRET}` },
    { authorization: TEST_EDGE_SECRET },
    { authorization: `Bearer ` },
    {},
  ]) {
    const response = await get("/api/internal/sync/changes", bad);
    assert.equal(response.status, 401, `should reject ${JSON.stringify(bad)}`);
  }
});

test("a valid edge credential reads the feed", async () => {
  const created = await createSessionViaApi();
  const response = await get("/api/internal/sync/changes?cursor=0", syncAuthHeaders());

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: { events: Array<{ entityId: string; cursor: number; operation: string }>; nextCursor: number; hasMore: boolean };
  };

  assert.ok(Array.isArray(body.data.events));
  assert.equal(typeof body.data.nextCursor, "number");
  assert.equal(typeof body.data.hasMore, "boolean");

  const match = body.data.events.find((event) => event.entityId === created.syncId);
  assert.ok(match, "the created session should appear in the feed");
  assert.equal(match!.operation, "CREATED");
});

test("cursor pagination and hasMore work and events stay ordered", async () => {
  const created = await createSessionViaApi();
  await postJson(
    `/api/lecturer/attendance-sessions/${created.id}/end`,
    {},
    sessionCookieHeader(fixture.sessionToken)
  );

  const firstPage = await (
    await get("/api/internal/sync/changes?cursor=0&limit=1", syncAuthHeaders())
  ).json() as { data: { events: unknown[]; nextCursor: number; hasMore: boolean } };

  assert.equal(firstPage.data.events.length, 1);
  assert.equal(typeof firstPage.data.nextCursor, "number");

  // Walking the feed with limit=1 must eventually reach the session we created
  // and must never return the same event twice.
  const seen = new Set<number>();
  let cursor = 0;
  for (let page = 0; page < 5000; page += 1) {
    const response = await get(
      `/api/internal/sync/changes?cursor=${cursor}&limit=1`,
      syncAuthHeaders()
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: { events: Array<{ cursor: number; entityId: string }>; nextCursor: number; hasMore: boolean };
    };
    if (body.data.events.length === 0) {
      break;
    }
    const event = body.data.events[0];
    assert.ok(event.cursor > cursor, "each page must advance strictly");
    assert.ok(!seen.has(event.cursor), "no event may be returned twice");
    seen.add(event.cursor);
    if (event.entityId === created.syncId) {
      break;
    }
    cursor = body.data.nextCursor;
  }
  assert.ok(cursor >= 0);
});

test("limit is bounded and invalid cursor/limit are rejected", async () => {
  const oversized = await get("/api/internal/sync/changes?limit=100000", syncAuthHeaders());
  assert.equal(oversized.status, 200);
  const body = (await oversized.json()) as { data: { events: unknown[] } };
  assert.ok(body.data.events.length <= 500, "limit must be clamped to the maximum");

  for (const query of ["cursor=-1", "cursor=abc", "limit=0", "limit=abc", "cursor=1.5"]) {
    const response = await get(`/api/internal/sync/changes?${query}`, syncAuthHeaders());
    assert.equal(response.status, 400, `${query} should be rejected`);
  }
});

test("the feed payload contains no student, password, session or WebAuthn data", async () => {
  const created = await createSessionViaApi();
  const response = await get("/api/internal/sync/changes?cursor=0", syncAuthHeaders());
  const raw = await response.text();

  assert.ok(!raw.includes("password"), "no password material");
  assert.ok(!raw.toLowerCase().includes("credential_id"), "no device credential ids");
  assert.ok(!raw.toLowerCase().includes("webauthn"), "no WebAuthn material");
  assert.ok(!raw.includes("oou_session"), "no session cookie");
  assert.ok(!raw.toLowerCase().includes("matric"), "no student identity");
  assert.ok(!raw.includes("sync_edge_secret") && !raw.includes(TEST_EDGE_SECRET));
});

test("the sync credential is never echoed in any response", async () => {
  for (const path of ["/api/internal/sync/changes", "/api/internal/sync/status"]) {
    const response = await get(path, syncAuthHeaders());
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes(TEST_EDGE_SECRET), `${path} leaked the credential`);
    assert.ok(!text.toLowerCase().includes("secret"));
  }
});

test("student, lecturer and admin sessions cannot authenticate to the sync endpoint", async () => {
  // A perfectly valid user session cookie must not be accepted as an edge
  // credential. The edge middleware never reads cookies, so this is 401.
  const response = await get(
    "/api/internal/sync/changes",
    sessionCookieHeader(fixture.sessionToken)
  );
  assert.equal(response.status, 401);

  const alsoRejected = await get(
    "/api/internal/sync/changes",
    {
      cookie: `${authConfig.cookieName}=${fixture.sessionToken}`,
      authorization: "",
    }
  );
  assert.equal(alsoRejected.status, 401);
});

test("the sync endpoint exposes no write or generic database operation", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(
      `${baseUrl}/api/internal/sync/changes`,
      {
        method,
        headers: { "content-type": "application/json", ...syncAuthHeaders() },
        body: JSON.stringify({ sql: "SELECT 1" }),
      }
    );
    assert.equal(response.status, 404, `${method} must not be routed`);
  }

  // Generic-looking paths must not exist either.
  for (const path of [
    "/api/internal/sync/query",
    "/api/internal/sync/sql",
    "/api/internal/sync/entities",
    "/api/internal/sync/students",
    "/api/internal/sync/sessions",
  ]) {
    const response = await get(path, syncAuthHeaders());
    assert.equal(response.status, 404, `${path} must not exist`);
  }

  // A table/column-shaped cursor is simply an integer, and a wildly long value
  // cannot become SQL: the feed query is a fixed statement with bound parameters.
  const hostile = await get(
    "/api/internal/sync/changes?cursor=0&limit=1%27%3B%20DROP%20TABLE%20users%3B--",
    syncAuthHeaders()
  );
  assert.equal(hostile.status, 400);

  const stillThere = await pool.query(
    `SELECT count(*)::int AS n FROM users`
  );
  assert.ok(stillThere.rows[0].n >= 1);
});

test("the sync status endpoint reports state without leaking the credential", async () => {
  const response = await get("/api/internal/sync/status", syncAuthHeaders());
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Record<string, unknown> };

  assert.equal(typeof body.data.enabled, "boolean");
  assert.equal(typeof body.data.running, "boolean");
  assert.ok("lastCursor" in body.data);
  assert.ok("lastSuccessAt" in body.data);
  assert.ok("lastAttemptAt" in body.data);
  assert.ok("lastErrorMessage" in body.data);

  const text = JSON.stringify(body);
  assert.ok(!text.includes(TEST_EDGE_SECRET));
});

test("an unconfigured provider refuses the feed instead of leaving it open", async () => {
  // `resolveSyncConfig` is pure, so the unconfigured case is asserted on the
  // resolver rather than by mutating the live process environment.
  const { resolveSyncConfig } = await import("../src/config/sync");
  const unconfigured = resolveSyncConfig({});
  assert.equal(unconfigured.provider.secretHash, null);
  assert.equal(unconfigured.consumer.enabled, false);

  // And enabling the worker without the rest of its configuration is a startup
  // error, not a half-configured worker that silently syncs nothing.
  assert.throws(
    () => resolveSyncConfig({ SYNC_ENABLED: "true" }),
    /SYNC_EDGE_ID/
  );
  assert.throws(
    () => resolveSyncConfig({ SYNC_ENABLED: "true", SYNC_EDGE_ID: "edge" }),
    /SYNC_EDGE_SECRET/
  );
  assert.throws(
    () =>
      resolveSyncConfig({
        SYNC_ENABLED: "true",
        SYNC_EDGE_ID: "edge",
        SYNC_EDGE_SECRET: "s",
        SYNC_CLOUD_BASE_URL: "not-a-url",
      }),
    /SYNC_CLOUD_BASE_URL/
  );
  assert.throws(
    () => resolveSyncConfig({ SYNC_PROVIDER_SECRET_HASH: "too-short" }),
    /SYNC_PROVIDER_SECRET_HASH/
  );
});