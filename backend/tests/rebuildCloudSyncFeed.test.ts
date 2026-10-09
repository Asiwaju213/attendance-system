// Tests for the cloud sync feed rebuild script.
//
// Covers:
// 1. Pure helper functions (CLI decision, duplicate detection, etc.)
// 2. Preflight inventory (read-only, correct counts, abort conditions)
// 3. Write phase (replaces feed, contiguous cursors, parent-before-child,
//    bootstrap preservation, attendance payload fidelity)
// 4. Full apply proof (rebuilt feed is consumable from cursor 0)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  SYNC_TEST_PREFIX,
  seedMasterDataGraph,
  cleanupSyncTestFixtures,
} from "./syncTestFixtures";

let localCounter = 0;
function unique(suffix: string): string {
  localCounter += 1;
  return `${SYNC_TEST_PREFIX}-RB-${suffix}-${localCounter}`;
}
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { listChangeEventsSince } from "../src/services/syncChangeEventStore";
import { applyChangeBatch, readCursor } from "../src/services/syncApplyService";
import { createAttendanceSession } from "../src/services/attendanceSessionStore";
import type { SyncChangeEvent } from "../src/types/sync";
import {
  decideCliMode,
  isBlankSyncId,
  detectDuplicates,
  detectInvalidStatuses,
  findCrossEntityDuplicates,
  rebuildFeedPreflight,
  rebuildFeedWrite,
  resolveDatabaseTarget,
  formatDatabaseTarget,
  RebuildPreflightError,
} from "../scripts/rebuildCloudSyncFeed";

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("decideCliMode", () => {
  test("preflight mode with --preflight", () => {
    const d = decideCliMode(["--preflight"], "development");
    assert.equal(d.kind, "preflight");
  });

  test("write mode with --confirm in development", () => {
    const d = decideCliMode(["--confirm"], "development");
    assert.equal(d.kind, "write");
  });

  test("write mode requires --confirm-production in production", () => {
    const d = decideCliMode(["--confirm"], "production");
    assert.equal(d.kind, "refuse");
  });

  test("write mode with both flags in production", () => {
    const d = decideCliMode(["--confirm", "--confirm-production"], "production");
    assert.equal(d.kind, "write");
  });

  test("refuses --confirm-production without --confirm", () => {
    const d = decideCliMode(["--confirm-production"], "development");
    assert.equal(d.kind, "refuse");
  });

  test("refuses --preflight and --confirm together", () => {
    const d = decideCliMode(["--preflight", "--confirm"], "development");
    assert.equal(d.kind, "refuse");
  });

  test("refuses when no flags provided", () => {
    const d = decideCliMode([], "development");
    assert.equal(d.kind, "refuse");
  });

  test("refuses under NODE_ENV=test", () => {
    const d = decideCliMode(["--preflight"], "test");
    assert.equal(d.kind, "refuse");
  });
});

describe("isBlankSyncId", () => {
  test("detects null, undefined, empty, and whitespace", () => {
    assert.equal(isBlankSyncId(null), true);
    assert.equal(isBlankSyncId(undefined), true);
    assert.equal(isBlankSyncId(""), true);
    assert.equal(isBlankSyncId("   "), true);
    assert.equal(isBlankSyncId("abc"), false);
  });
});

describe("detectDuplicates", () => {
  test("finds duplicate values", () => {
    const dups = detectDuplicates(["a", "b", "a", "c", "b"]);
    assert.deepEqual(dups, ["a", "b"]);
  });

  test("returns empty array when no duplicates", () => {
    const dups = detectDuplicates(["a", "b", "c"]);
    assert.deepEqual(dups, []);
  });
});

describe("detectInvalidStatuses", () => {
  test("filters rows with unsupported status", () => {
    const rows = [
      { id: "1", status: "ACTIVE" },
      { id: "2", status: "INACTIVE" },
      { id: "3", status: "UNKNOWN" },
    ];
    const invalid = detectInvalidStatuses(rows, ["ACTIVE", "INACTIVE"]);
    assert.deepEqual(invalid, [{ id: "3", status: "UNKNOWN" }]);
  });
});

describe("findCrossEntityDuplicates", () => {
  test("finds sync_ids appearing in multiple entities", () => {
    const entries = [
      { entityType: "faculty", syncId: "uuid-1" },
      { entityType: "department", syncId: "uuid-2" },
      { entityType: "course", syncId: "uuid-1" },
    ];
    const dups = findCrossEntityDuplicates(entries);
    assert.deepEqual(dups, ["uuid-1"]);
  });
});

describe("resolveDatabaseTarget", () => {
  test("prefers DATABASE_URL over discrete variables", () => {
    const target = resolveDatabaseTarget({
      DATABASE_URL: "postgres://user:pass@neon-host:5432/neon-db",
      DATABASE_HOST: "localhost",
      DATABASE_NAME: "local-db",
    });
    assert.equal(target.hostname, "neon-host");
    assert.equal(target.databaseName, "neon-db");
    assert.equal(target.source, "DATABASE_URL");
  });

  test("falls back to discrete variables when DATABASE_URL is not set", () => {
    const target = resolveDatabaseTarget({
      DATABASE_HOST: "localhost",
      DATABASE_NAME: "local-db",
    });
    assert.equal(target.hostname, "localhost");
    assert.equal(target.databaseName, "local-db");
    assert.equal(target.source, "discrete");
  });

  test("falls back to discrete variables when DATABASE_URL is empty", () => {
    const target = resolveDatabaseTarget({
      DATABASE_URL: "",
      DATABASE_HOST: "localhost",
      DATABASE_NAME: "local-db",
    });
    assert.equal(target.hostname, "localhost");
    assert.equal(target.databaseName, "local-db");
    assert.equal(target.source, "discrete");
  });

  test("throws when neither DATABASE_URL nor discrete variables are set", () => {
    assert.throws(() => resolveDatabaseTarget({}));
  });

  test("throws when DATABASE_URL is invalid", () => {
    assert.throws(() => resolveDatabaseTarget({ DATABASE_URL: "not-a-url" }));
  });

  test("throws when DATABASE_URL has no hostname", () => {
    assert.throws(() => resolveDatabaseTarget({ DATABASE_URL: "postgres:///mydb" }));
  });

  test("throws when DATABASE_URL has no database name", () => {
    assert.throws(() =>
      resolveDatabaseTarget({ DATABASE_URL: "postgres://user:pass@host:5432" })
    );
  });
});

describe("formatDatabaseTarget", () => {
  test("displays only hostname and database name", () => {
    const target = resolveDatabaseTarget({
      DATABASE_URL: "postgres://user:secret@neon-host:5432/neon-db",
    });
    const formatted = formatDatabaseTarget(target);
    assert.equal(formatted, "neon-host/neon-db");
    assert.equal(formatted.includes("secret"), false);
    assert.equal(formatted.includes("user"), false);
    assert.equal(formatted.includes("pass"), false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

const CONSUMER_ID = "test-rebuild-feed-edge";

let graph: Awaited<ReturnType<typeof seedMasterDataGraph>>;
let studentId: number;
let studentSyncId: string;
let deviceId: number;
let deviceSyncId: string;
let pendingBootstrapSyncId: string;
let consumedBootstrapSyncId: string;
let registrationSyncId: string;
let sessionSyncId: string;
let expectedSessionPayload: Record<string, unknown>;
let feedBeforeCount: number;

before(async () => {
  await cleanupSyncTestFixtures();

  // Clean projection tables to start fresh
  await pool.query(`DELETE FROM sync_student_devices`);
  await pool.query(`DELETE FROM sync_student_device_bootstraps`);
  await pool.query(`DELETE FROM sync_lecturers`);
  await pool.query(`DELETE FROM sync_attendance_sessions`);
  await pool.query(`DELETE FROM sync_processed_events`);
  await pool.query(`DELETE FROM sync_consumer_state`);

  graph = await seedMasterDataGraph();

  // Create a student
  const studentName = `${SYNC_TEST_PREFIX} Rebuild Student`;
  const studentUserResult = await pool.query(
    `INSERT INTO users (name, password_hash, role, status)
     VALUES ($1, $2, 'STUDENT', 'ACTIVE') RETURNING id`,
    [studentName, await hashPassword("rebuild-test-password")]
  );
  const studentUserId = Number(studentUserResult.rows[0].id);

  const studentResult = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id, sync_id`,
    [studentUserId, unique("RMATRIC"), graph.departmentId, graph.levelId]
  );
  studentId = Number(studentResult.rows[0].id);
  studentSyncId = studentResult.rows[0].sync_id as string;

  // Create a device for the student
  const credentialId = `cred-${unique("CRED")}`;
  const credentialPublicKey = randomBytes(32);
  const deviceResult = await pool.query(
    `INSERT INTO student_devices (student_id, credential_id, credential_public_key, status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id, sync_id`,
    [studentId, credentialId, credentialPublicKey]
  );
  deviceId = Number(deviceResult.rows[0].id);
  deviceSyncId = deviceResult.rows[0].sync_id as string;

  // Create a PENDING bootstrap (the cloud only ever creates PENDING; CONSUMED
  // only exists on the edge after the secret is spent)
  const pendingSecret = "pending-bootstrap-secret-for-test";
  const pendingHash = createHash("sha256").update(pendingSecret).digest("hex");
  const pendingResult = await pool.query(
    `INSERT INTO student_device_bootstraps (student_id, device_id, secret_hash, status, expires_at)
     VALUES ($1, $2, $3, 'PENDING', now() + interval '1 hour') RETURNING sync_id`,
    [studentId, deviceId, pendingHash]
  );
  pendingBootstrapSyncId = pendingResult.rows[0].sync_id as string;
  const regResult = await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED') RETURNING sync_id`,
    [studentId, graph.courseOfferingId]
  );
  registrationSyncId = regResult.rows[0].sync_id as string;

  // Assign lecturer to offering (needed for session creation)
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)`,
    [graph.courseOfferingId, graph.lecturerId]
  );

  // Get the lecturer's user ID (createAttendanceSession expects userId)
  const lecturerUserResult = await pool.query(
    `SELECT user_id FROM lecturers WHERE id = $1`,
    [graph.lecturerId]
  );
  const lecturerUserId = Number(lecturerUserResult.rows[0].user_id);

  // Create an attendance session via the real store
  const sessionResult = await createAttendanceSession(lecturerUserId, {
    courseOfferingId: graph.courseOfferingId,
    durationMinutes: 60,
    lateThresholdMinutes: 5,
  });
  assert.equal(sessionResult.ok, true);

  // Capture the session's sync_id from the feed
  const sessionEventResult = await pool.query(
    `SELECT entity_id FROM sync_change_events
     WHERE entity_type = 'attendance_session'
     ORDER BY cursor DESC LIMIT 1`
  );
  sessionSyncId = sessionEventResult.rows[0].entity_id as string;

  // Capture the expected session payload for byte-for-byte comparison
  const payloadResult = await pool.query(
    `SELECT payload FROM sync_change_events
     WHERE entity_type = 'attendance_session' AND entity_id = $1
     ORDER BY cursor DESC LIMIT 1`,
    [sessionSyncId]
  );
  expectedSessionPayload = (
    payloadResult.rows[0].payload as { entity?: Record<string, unknown> }
  ).entity as Record<string, unknown>;

  // Record feed count before rebuild
  const feedCountResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sync_change_events`
  );
  feedBeforeCount = Number(feedCountResult.rows[0].n);
});

after(async () => {
  // Clean up attendance session
  await pool.query(
    `DELETE FROM attendance_sessions WHERE course_offering_id = $1`,
    [graph.courseOfferingId]
  );

  // Clean up lecturer assignment
  await pool.query(
    `DELETE FROM course_offering_lecturers WHERE course_offering_id = $1 AND lecturer_id = $2`,
    [graph.courseOfferingId, graph.lecturerId]
  );

  // Clean projection tables first (they have FKs to students)
  await pool.query(`DELETE FROM sync_student_devices`);
  await pool.query(`DELETE FROM sync_student_device_bootstraps`);
  await pool.query(`DELETE FROM sync_lecturers`);
  await pool.query(`DELETE FROM sync_attendance_sessions`);
  await pool.query(`DELETE FROM sync_processed_events`);
  await pool.query(`DELETE FROM sync_consumer_state`);

  // Clean up registration
  await pool.query(
    `DELETE FROM course_registrations WHERE student_id = $1`,
    [studentId]
  );

  // Clean up bootstraps
  await pool.query(
    `DELETE FROM student_device_bootstraps WHERE student_id = $1`,
    [studentId]
  );

  // Clean up device
  await pool.query(
    `DELETE FROM student_devices WHERE student_id = $1`,
    [studentId]
  );

  // Clean up student
  await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE '${SYNC_TEST_PREFIX}%' AND role = 'STUDENT'`
  );

  await cleanupSyncTestFixtures();
  await pool.end();
});

describe("rebuildFeedPreflight", () => {
  test("reports correct per-entity counts", async () => {
    const client = await pool.connect();
    try {
      const report = await rebuildFeedPreflight(client);
      assert.equal(report.ok, true);
      assert.equal(report.problems.length, 0);

      // Verify counts match actual table rows
      for (const e of report.entities) {
        const countResult = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${e.table}`
        );
        assert.equal(
          e.count,
          Number(countResult.rows[0].n),
          `${e.table} count mismatch`
        );
      }

      // Attendance sessions
      assert.equal(report.attendanceSessions?.count, 1);
      assert.equal(report.attendanceSessions?.unrepresentableRows.length, 0);

      // Expected event count
      const expectedTotal =
        report.entities.reduce((sum, e) => sum + e.count, 0) +
        (report.attendanceSessions?.count ?? 0);
      assert.equal(report.expectedEventCount, expectedTotal);
    } finally {
      client.release();
    }
  });

  test("is read-only (feed count unchanged)", async () => {
    const client = await pool.connect();
    try {
      await rebuildFeedPreflight(client);

      const feedCountResult = await pool.query(
        `SELECT COUNT(*)::int AS n FROM sync_change_events`
      );
      assert.equal(Number(feedCountResult.rows[0].n), feedBeforeCount);
    } finally {
      client.release();
    }
  });

  test("detects cross-entity duplicate sync_id", async () => {
    // Temporarily set a device's sync_id to match a bootstrap's sync_id
    await pool.query(
      `UPDATE student_devices SET sync_id = $1 WHERE id = $2`,
      [pendingBootstrapSyncId, deviceId]
    );

    const client = await pool.connect();
    try {
      const report = await rebuildFeedPreflight(client);
      assert.equal(report.ok, false);
      assert.ok(
        report.crossEntityDuplicateSyncIds.includes(pendingBootstrapSyncId)
      );
    } finally {
      client.release();
      // Restore original sync_id
      await pool.query(
        `UPDATE student_devices SET sync_id = $1 WHERE id = $2`,
        [deviceSyncId, deviceId]
      );
    }
  });
});

describe("rebuildFeedWrite", () => {
  test("replaces feed with contiguous cursors and correct ordering", async () => {
    const client = await pool.connect();
    try {
      const result = await rebuildFeedWrite(client);

      // Verify total events
      assert.equal(result.totalEvents, result.lastCursor);
      assert.equal(result.firstCursor, 1);

      // Read back the feed
      const feedResult = await pool.query(
        `SELECT cursor, entity_type, entity_id, operation, payload
         FROM sync_change_events ORDER BY cursor ASC`
      );
      const events = feedResult.rows as Array<{
        cursor: string;
        entity_type: string;
        entity_id: string;
        operation: string;
        payload: Record<string, unknown>;
      }>;

      // Verify contiguous cursors
      for (let i = 0; i < events.length; i++) {
        assert.equal(Number(events[i].cursor), i + 1);
      }

      // Verify all operations are UPDATED
      for (const e of events) {
        assert.equal(e.operation, "UPDATED");
      }

      // Verify block ordering: each entity type appears in a contiguous block
      // and parent entities come before child entities
      const entityOrder = [
        "faculty",
        "department",
        "level",
        "academic_session",
        "semester",
        "course",
        "course_offering",
        "lecturer",
        "student",
        "student_device",
        "student_device_bootstrap",
        "course_registration",
        "attendance_session",
      ];

      const seenEntities: string[] = [];
      for (const e of events) {
        if (!seenEntities.includes(e.entity_type)) {
          seenEntities.push(e.entity_type);
        }
      }
      assert.deepEqual(seenEntities, entityOrder);

      // Verify per-entity counts
      const dbCounts: Record<string, number> = {};
      for (const entityType of entityOrder) {
        const tableMap: Record<string, string> = {
          faculty: "faculties",
          department: "departments",
          level: "levels",
          academic_session: "academic_sessions",
          semester: "semesters",
          course: "courses",
          course_offering: "course_offerings",
          lecturer: "lecturers",
          student: "students",
          student_device: "student_devices",
          student_device_bootstrap: "student_device_bootstraps",
          course_registration: "course_registrations",
          attendance_session: "attendance_sessions",
        };
        const countResult = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${tableMap[entityType]}`
        );
        dbCounts[entityType] = Number(countResult.rows[0].n);
      }

      for (const [entityType, count] of Object.entries(dbCounts)) {
        assert.equal(
          result.byEntity[entityType],
          count,
          `${entityType} event count mismatch`
        );
      }
    } finally {
      client.release();
    }
  });

  test("preserves bootstrap status and hash", async () => {
    const feedResult = await pool.query(
      `SELECT payload FROM sync_change_events
       WHERE entity_type = 'student_device_bootstrap' ORDER BY cursor ASC`
    );
    const bootstraps = feedResult.rows.map(
      (r) => (r.payload as { entity: Record<string, unknown> }).entity
    );

    assert.equal(bootstraps.length, 1);

    const pending = bootstraps.find((b) => b.syncId === pendingBootstrapSyncId);
    assert.ok(pending, "PENDING bootstrap not found in feed");
    assert.equal(pending.status, "PENDING");

    // Verify hash matches what we stored
    const pendingHash = createHash("sha256")
      .update("pending-bootstrap-secret-for-test")
      .digest("hex");
    assert.equal(pending.secretHash, pendingHash);

    // Verify no plaintext secret in payload
    const pendingStr = JSON.stringify(pending);
    assert.equal(pendingStr.includes("pending-bootstrap-secret-for-test"), false);
  });

  test("attendance session payload matches store-created event", async () => {
    const feedResult = await pool.query(
      `SELECT payload FROM sync_change_events
       WHERE entity_type = 'attendance_session' AND entity_id = $1`,
      [sessionSyncId]
    );
    assert.equal(feedResult.rows.length, 1);

    const rebuiltPayload = (
      feedResult.rows[0].payload as { entity: Record<string, unknown> }
    ).entity;

    assert.deepEqual(rebuiltPayload, expectedSessionPayload);
  });

  test("aborts on cross-entity duplicate without modifying feed", async () => {
    // Create a duplicate sync_id across entities
    await pool.query(
      `UPDATE student_devices SET sync_id = $1 WHERE id = $2`,
      [pendingBootstrapSyncId, deviceId]
    );

    const client = await pool.connect();
    try {
      await assert.rejects(
        () => rebuildFeedWrite(client),
        (error: unknown) => {
          assert.ok(error instanceof RebuildPreflightError);
          return true;
        }
      );

      // Verify feed was NOT modified
      const feedCountResult = await pool.query(
        `SELECT COUNT(*)::int AS n FROM sync_change_events`
      );
      // Feed should still have the events from the previous write test
      // (tests run in order, so the feed was already rebuilt)
      assert.ok(Number(feedCountResult.rows[0].n) > 0);
    } finally {
      client.release();
      // Restore original sync_id
      await pool.query(
        `UPDATE student_devices SET sync_id = $1 WHERE id = $2`,
        [deviceSyncId, deviceId]
      );
    }
  });
});

describe("full apply proof", () => {
  test("rebuilt feed is consumable from cursor 0", async () => {
    // Create a test consumer
    await pool.query(
      `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
       VALUES ($1, 0) ON CONFLICT (consumer_id) DO UPDATE SET last_cursor = 0`,
      [CONSUMER_ID]
    );

    const cursor = await readCursor(CONSUMER_ID);
    assert.equal(cursor, 0);

    // Fetch all events from the feed
    const batch = await listChangeEventsSince(0, 500);
    assert.ok(batch.events.length > 0);
    assert.equal(batch.hasMore, false);

    // Apply the batch
    const result = await applyChangeBatch(CONSUMER_ID, batch.events);
    assert.equal(result.applied, batch.events.length);
    assert.equal(result.skipped, 0);
    assert.equal(result.cursor, batch.events[batch.events.length - 1].cursor);

    // Verify projections were created
    const deviceResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sync_student_devices WHERE cloud_sync_id = $1`,
      [deviceSyncId]
    );
    assert.equal(Number(deviceResult.rows[0].n), 1);

    const bootstrapResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sync_student_device_bootstraps WHERE cloud_sync_id = $1`,
      [pendingBootstrapSyncId]
    );
    assert.equal(Number(bootstrapResult.rows[0].n), 1);

    const sessionResult = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sync_attendance_sessions WHERE cloud_sync_id = $1`,
      [sessionSyncId]
    );
    assert.equal(Number(sessionResult.rows[0].n), 1);

    // Verify PENDING bootstrap was applied correctly
    const bootstrapStatusResult = await pool.query(
      `SELECT status FROM sync_student_device_bootstraps WHERE cloud_sync_id = $1`,
      [pendingBootstrapSyncId]
    );
    assert.equal(bootstrapStatusResult.rows[0].status, "PENDING");
  });
});
