// Outbound queue recovery and diagnostics (Workstream C).
//
// Exercises, directly against the store:
//   - per-row retry backoff: a failed mark is not re-claimed until its
//     attempt-appropriate delay has elapsed, and re-claims in its original order;
//   - stale (expired-lease) claim release: only claims older than the threshold
//     are released, the action is idempotent, and the health counts agree;
//   - the RETRY verdict's retry-loop state (attempts, last_error, cleared claim);
//   - the `retrying` diagnostic (PENDING rows that have already failed);
//   - clean-up ordering: the queue's RESTRICT FKs prove children must be deleted
//     before their parents.
//
// Hermetic like syncOutboundClaim.test.ts: marks are queued in 2026 so they are
// always the oldest, every claim is limited to rows this file inserted, and
// `after` deletes exactly those rows plus the student/user/department/faculty it
// created.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import {
  claimPendingUploads,
  countStaleUploadClaims,
  readOutboundQueueSummary,
  recordUploadResult,
  releaseStaleUploadClaims,
  retryBackoffDelayMs,
} from "../src/services/syncOutboundQueueStore";

let facultyId = 0;
let departmentId = 0;
let userId = 0;
let studentId = 0;
let matric = "";
const myQueueIds: string[] = [];

interface MarkOptions {
  queuedAt: string;
  status?: string;
  attempts?: number;
  lastAttemptAt?: string | null;
}

async function insertMark(options: MarkOptions): Promise<string> {
  const {
    queuedAt,
    status = "PENDING",
    attempts = 0,
    lastAttemptAt = null,
  } = options;
  const result = await pool.query(
    `INSERT INTO sync_outbound_attendance_marks
       (attendance_record_id, session_sync_id, student_id, matric_number, mark_status, mark_time, queued_at, status, attempts, last_attempt_at)
     VALUES (NULL, $1, $2, $3, 'PRESENT', $4, $5, $6, $7, $8)
     RETURNING queue_id`,
    [
      randomUUID(),
      studentId,
      matric,
      "2026-01-01T00:00:00.000Z",
      queuedAt,
      status,
      attempts,
      lastAttemptAt,
    ]
  );
  const queueId = result.rows[0].queue_id as string;
  myQueueIds.push(queueId);
  return queueId;
}

async function markStatus(queueId: string): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
}> {
  const result = await pool.query(
    `SELECT status, attempts, last_error, claimed_by, claimed_at
     FROM sync_outbound_attendance_marks
     WHERE queue_id = $1`,
    [queueId]
  );
  const row = result.rows[0];
  return {
    status: row.status,
    attempts: Number(row.attempts),
    last_error: row.last_error as string | null,
    claimed_by: row.claimed_by as string | null,
    claimed_at: row.claimed_at as Date | null,
  };
}

before(async () => {
  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    ["Recovery Test Faculty", "RCF-" + randomUUID().slice(0, 8)]
  );
  facultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3) RETURNING id`,
    ["Recovery Test Department", "RCD-" + randomUUID().slice(0, 8), facultyId]
  );
  departmentId = Number(department.rows[0].id);

  const user = await pool.query(
    `INSERT INTO users (name, password_hash, role) VALUES ($1, 'x', 'STUDENT') RETURNING id`,
    ["Recovery Test Student"]
  );
  userId = Number(user.rows[0].id);

  matric = "RCD/" + randomUUID().slice(0, 8);
  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  const levelId = Number(level.rows[0].id);
  const student = await pool.query(
    `INSERT INTO students (user_id, matric_number, department_id, level_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, matric, departmentId, levelId]
  );
  studentId = Number(student.rows[0].id);
});

beforeEach(async () => {
  if (myQueueIds.length > 0) {
    await pool.query(
      `DELETE FROM sync_outbound_attendance_marks WHERE queue_id = ANY($1::uuid[])`,
      [myQueueIds]
    );
    myQueueIds.length = 0;
  }
});

after(async () => {
  await pool.query(
    `DELETE FROM sync_outbound_attendance_marks WHERE queue_id = ANY($1::uuid[])`,
    [myQueueIds]
  );
  await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM departments WHERE id = $1`, [departmentId]);
  await pool.query(`DELETE FROM faculties WHERE id = $1`, [facultyId]);
  await pool.end();
});

test("retryBackoffDelayMs grows and caps the retry backoff", () => {
  assert.equal(retryBackoffDelayMs(0), 0);
  assert.equal(retryBackoffDelayMs(-2), 0);
  assert.equal(retryBackoffDelayMs(1), 2_000);
  assert.equal(retryBackoffDelayMs(2), 5_000);
  assert.equal(retryBackoffDelayMs(5), 60_000);
  assert.equal(retryBackoffDelayMs(7), 240_000);
  assert.equal(retryBackoffDelayMs(8), 300_000);
  assert.equal(retryBackoffDelayMs(999), 300_000);
});

test("a recently-failed mark is not re-claimed, but fresh marks behind it are", async () => {
  const failed = await insertMark({
    queuedAt: "2026-01-01T00:00:01.000Z",
    attempts: 5,
    lastAttemptAt: new Date().toISOString(),
  });
  const fresh = await insertMark({ queuedAt: "2026-01-01T00:00:02.000Z" });

  const claimed = await claimPendingUploads(2, "edge-one", 60_000);
  assert.deepEqual(
    claimed.map((mark) => mark.queueId),
    [fresh],
    "the fresh mark is claimable while the failed mark waits out its backoff"
  );
  assert.equal(
    (await markStatus(failed)).status,
    "PENDING",
    "the failed mark stays PENDING until its backoff has elapsed"
  );
});

test("a failed mark that has served its backoff returns in its original queue position", async () => {
  const failed = await insertMark({
    queuedAt: "2026-01-01T00:00:10.000Z",
    attempts: 5,
    lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const mid = await insertMark({ queuedAt: "2026-01-01T00:00:11.000Z" });
  const late = await insertMark({ queuedAt: "2026-01-01T00:00:13.000Z" });

  const claimed = await claimPendingUploads(3, "edge-one", 60_000);
  assert.deepEqual(
    claimed.map((mark) => mark.queueId),
    [failed, mid, late],
    "the due failed mark is re-claimed ahead of marks queued after it, by queued_at"
  );
});

test("a failed mark is reclaimed exactly once its per-row backoff has elapsed", async () => {
  const justTried = await insertMark({
    queuedAt: "2026-01-01T00:01:00.000Z",
    attempts: 1,
    lastAttemptAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const waited = await insertMark({
    queuedAt: "2026-01-01T00:01:01.000Z",
    attempts: 1,
    lastAttemptAt: new Date(Date.now() - 3_000).toISOString(),
  });

  const claimed = await claimPendingUploads(2, "edge-one", 60_000);
  assert.deepEqual(
    claimed.map((mark) => mark.queueId),
    [waited],
    "attempts=1 delays 2s: the mark tried 1s ago waits, the one tried 3s ago is due"
  );
});

test("releaseStaleUploadClaims only releases expired leases and is idempotent", async () => {
  const stale = await insertMark({ queuedAt: "2026-01-01T00:02:00.000Z" });
  const fresh = await insertMark({ queuedAt: "2026-01-01T00:02:01.000Z" });
  await claimPendingUploads(2, "dead-edge", 60_000);

  await pool.query(
    `UPDATE sync_outbound_attendance_marks
        SET claimed_at = now() - interval '10 minutes'
      WHERE queue_id = $1`,
    [stale]
  );

  assert.equal(await countStaleUploadClaims(60_000), 1);

  const released = await releaseStaleUploadClaims(60_000);
  assert.equal(released, 1, "only the backdated claim crosses the threshold");

  const staleRow = await markStatus(stale);
  assert.equal(staleRow.status, "PENDING");
  assert.equal(staleRow.claimed_by, null);
  assert.equal(staleRow.claimed_at, null);

  const freshRow = await markStatus(fresh);
  assert.equal(freshRow.status, "IN_FLIGHT", "a still-live claim is never preempted");

  assert.equal(
    await releaseStaleUploadClaims(60_000),
    0,
    "releasing again is a no-op (idempotent)"
  );
  assert.equal(await countStaleUploadClaims(60_000), 0);

  const summary = await readOutboundQueueSummary();
  assert.equal(summary.inFlight, 1, "the healthy claim remains in flight");
});

test("the RETRY verdict drives retry-loop state and gates the next claim", async () => {
  const retried = await insertMark({ queuedAt: "2026-01-01T00:03:00.000Z" });
  await claimPendingUploads(1, "edge-one", 60_000);

  await recordUploadResult(retried, { outcome: "RETRY", reason: "timeout" });

  const row = await markStatus(retried);
  assert.equal(row.status, "PENDING", "a retry returns to the queue");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "timeout");
  assert.equal(row.claimed_by, null, "the claim is cleared");
  assert.equal(row.claimed_at, null);

  const next = await claimPendingUploads(1, "edge-one", 60_000);
  assert.deepEqual(
    next.map((mark) => mark.queueId),
    [],
    "the just-failed mark is not re-claimed before its backoff"
  );

  const retrying = await readOutboundQueueSummary();
  assert.equal(retrying.retrying, 1, "PENDING rows with attempts>0 are the retrying count");
});

test("readOutboundQueueSummary counts retrying only for PENDING rows that failed", async () => {
  const pendingFresh = await insertMark({ queuedAt: "2026-01-01T00:04:00.000Z" });
  const pendingFailed = await insertMark({
    queuedAt: "2026-01-01T00:04:01.000Z",
    attempts: 3,
    lastAttemptAt: new Date().toISOString(),
  });
  const rejected = await insertMark({
    queuedAt: "2026-01-01T00:04:02.000Z",
    status: "REJECTED",
    attempts: 1,
  });

  await claimPendingUploads(1, "edge-one", 60_000);

  const summary = await readOutboundQueueSummary();
  assert.equal(summary.retrying, 1, "only the PENDING failed row is retrying");
  assert.equal(
    summary.pending,
    1,
    "the fresh row was claimed to IN_FLIGHT; the failed row waits, still PENDING"
  );
  assert.equal((await markStatus(pendingFresh)).status, "IN_FLIGHT");
  assert.equal((await markStatus(rejected)).status, "REJECTED");
});

test("cleanup must delete queue children before their FK parents (RESTRICT)", async () => {
  const queued = await insertMark({ queuedAt: "2026-01-01T00:05:00.000Z" });

  // Deleting the student first is the wrong order: the queued mark references it.
  // ON DELETE RESTRICT surfaces as SQLSTATE 23001 (restrict_violation).
  await assert.rejects(
    pool.query(`DELETE FROM students WHERE id = $1`, [studentId]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "23001");
      assert.equal(
        (error as { constraint?: string }).constraint,
        "sync_outbound_attendance_marks_student_id_fkey"
      );
      return true;
    },
    "the queue's student FK RESTRICTs deleting a student that still has marks"
  );

  // Child-first: remove the queue row, then the student can be deleted.
  await pool.query(
    `DELETE FROM sync_outbound_attendance_marks WHERE queue_id = $1`,
    [queued]
  );
  myQueueIds.splice(myQueueIds.indexOf(queued), 1);

  await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
  const stillThere = await pool.query(
    `SELECT count(*)::int AS n FROM students WHERE id = $1`,
    [studentId]
  );
  assert.equal(Number(stillThere.rows[0].n), 0);
});