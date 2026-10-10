// The outbound uploader's claim (syncOutboundQueueStore, Task 5).
//
// Draining the attendance queue is a network operation, so "which rows are being
// sent right now" must be visible, and no two drains may ever send the same row.
// This file exercises the claim directly against the store: leases, oldest-first
// ordering, parallel drains, and how each verdict clears the claim.
//
// The queue table is SHARED with every other suite, which can leave rows behind
// (e.g. a SCSS suite that never cleaned its marks). This file is hermetic about
// that: its marks are always the OLDEST in the table (queued_at 2026, before any
// leftover from a 2026-era run can exist), every claim is limited to exactly the
// rows this file inserted, and `after` deletes exactly those rows plus the one
// student/department/user they reference.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import {
  claimPendingUploads,
  readOutboundQueueSummary,
  recordUploadResult,
  releaseUploadClaim,
  requeueRejectedMark,
} from "../src/services/syncOutboundQueueStore";

let facultyId = 0;
let departmentId = 0;
let userId = 0;
let studentId = 0;
let matric = "";
const myQueueIds: string[] = [];

async function insertMark(
  queuedAt: string,
  status = "PENDING"
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO sync_outbound_attendance_marks
       (attendance_record_id, session_sync_id, student_id, matric_number, mark_status, mark_time, queued_at, status)
     VALUES (NULL, $1, $2, $3, 'PRESENT', $4, $5, $6)
     RETURNING queue_id`,
    [randomUUID(), studentId, matric, "2026-01-01T00:00:00.000Z", queuedAt, status]
  );
  const queueId = result.rows[0].queue_id as string;
  myQueueIds.push(queueId);
  return queueId;
}

async function markStatus(queueId: string): Promise<{
  status: string;
  claimed_by: string | null;
  claimed_at: Date | null;
}> {
  const result = await pool.query(
    `SELECT status, claimed_by, claimed_at
     FROM sync_outbound_attendance_marks
     WHERE queue_id = $1`,
    [queueId]
  );
  return result.rows[0];
}

before(async () => {
  const faculty = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ($1, $2) RETURNING id`,
    ["Claim Test Faculty", "CLMF-" + randomUUID().slice(0, 8)]
  );
  facultyId = Number(faculty.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id) VALUES ($1, $2, $3) RETURNING id`,
    ["Claim Test Department", "CLM-" + randomUUID().slice(0, 8), facultyId]
  );
  departmentId = Number(department.rows[0].id);

  const user = await pool.query(
    `INSERT INTO users (name, password_hash, role) VALUES ($1, 'x', 'STUDENT') RETURNING id`,
    ["Claim Test Student"]
  );
  userId = Number(user.rows[0].id);

  matric = "CLM/" + randomUUID().slice(0, 8);
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
  // Every test starts with an empty slate of THIS file's marks, so each test can
  // claim exactly the rows it inserts. Leftover marks from other suites are never
  // claimed because this file's rows are always older (queued_at 2026).
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

test("claimPendingUploads claims the oldest batch IN_FLIGHT with a lease", async () => {
  const t0 = await insertMark("2026-01-01T00:00:00.000Z");
  const t2 = await insertMark("2026-01-01T00:00:02.000Z");
  const t1 = await insertMark("2026-01-01T00:00:01.000Z");
  const t3 = await insertMark("2026-01-01T00:00:03.000Z");

  const claimed = await claimPendingUploads(3, "edge-one", 60_000);
  assert.equal(claimed.length, 3);
  assert.deepEqual(
    claimed.map((mark) => mark.queueId),
    [t0, t1, t2],
    "oldest queued_at first, regardless of insert order"
  );

  for (const queueId of [t0, t1, t2]) {
    const row = await markStatus(queueId);
    assert.equal(row.status, "IN_FLIGHT");
    assert.equal(row.claimed_by, "edge-one");
    assert.ok(row.claimed_at !== null, "a claim carries the moment it was taken");
  }
  assert.equal((await markStatus(t3)).status, "PENDING", "the last row is not claimed yet");
});

test("an expired claim is reclaimed in its original queue position", async () => {
  const a = await insertMark("2026-01-01T00:00:10.000Z");
  const b = await insertMark("2026-01-01T00:00:11.000Z");
  const first = await claimPendingUploads(2, "stalled-edge", 60_000);
  assert.deepEqual(first.map((mark) => mark.queueId), [a, b]);

  // A worker that died mid-upload leaves its lease to age past the timeout.
  await pool.query(
    `UPDATE sync_outbound_attendance_marks
        SET claimed_at = now() - interval '2 minutes'
      WHERE queue_id = ANY($1::uuid[])`,
    [[a, b]]
  );

  const c = await insertMark("2026-01-01T00:00:12.000Z");
  const reclaim = await claimPendingUploads(3, "healthy-edge", 30_000);
  assert.deepEqual(
    reclaim.map((mark) => mark.queueId),
    [a, b, c],
    "the stale batch returns in its original order, ahead of newer marks"
  );
});

test("two concurrent drains never claim the same row", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push(await insertMark(`2026-01-01T00:00:${40 + i}.000Z`));
  }

  const [first, second] = await Promise.all([
    claimPendingUploads(4, "drain-a", 60_000),
    claimPendingUploads(4, "drain-b", 60_000),
  ]);

  const claimed = [...first, ...second].map((mark) => mark.queueId);
  assert.equal(claimed.length, 6, "every row is claimed across the two drains");
  assert.equal(new Set(claimed).size, 6, "no row is claimed twice");
});

test("releaseUploadClaim returns a claimed batch to PENDING and clears the lease", async () => {
  const a = await insertMark("2026-01-01T00:00:20.000Z");
  const b = await insertMark("2026-01-01T00:00:21.000Z");
  await claimPendingUploads(2, "edge-one", 60_000);

  await releaseUploadClaim([a]);

  const released = await markStatus(a);
  assert.equal(released.status, "PENDING");
  assert.equal(released.claimed_by, null);
  assert.equal(released.claimed_at, null);

  assert.equal((await markStatus(b)).status, "IN_FLIGHT", "releasing one row leaves the rest alone");

  await releaseUploadClaim([a]);
  assert.equal(
    (await markStatus(a)).status,
    "PENDING",
    "releasing a row that is no longer claimed is a no-op"
  );
  await releaseUploadClaim([]);
});

test("recordUploadResult resolves a claimed batch and clears the lease", async () => {
  const sent = await insertMark("2026-01-01T00:00:30.000Z");
  const rejected = await insertMark("2026-01-01T00:00:31.000Z");
  const retried = await insertMark("2026-01-01T00:00:32.000Z");
  await claimPendingUploads(3, "edge-one", 60_000);

  await recordUploadResult(sent, { outcome: "SENT", cloudRecordId: 7 });
  await recordUploadResult(rejected, { outcome: "REJECTED", reason: "unknown session" });
  await recordUploadResult(retried, { outcome: "RETRY", reason: "timeout" });

  const sentRow = await markStatus(sent);
  assert.equal(sentRow.status, "SENT");
  const sentInfo = await pool.query(
    `SELECT cloud_record_id FROM sync_outbound_attendance_marks WHERE queue_id = $1`,
    [sent]
  );
  assert.equal(Number(sentInfo.rows[0].cloud_record_id), 7);

  const rejectedRow = await markStatus(rejected);
  assert.equal(rejectedRow.status, "REJECTED");

  const retriedRow = await markStatus(retried);
  assert.equal(retriedRow.status, "PENDING", "a retry returns to the queue");

  for (const queueId of [sent, rejected, retried]) {
    const row = await markStatus(queueId);
    assert.equal(row.claimed_by, null, "no verdict leaves a claim behind");
    assert.equal(row.claimed_at, null);
  }
});

test("requeueRejectedMark returns a REJECTED mark to PENDING", async () => {
  const rejected = await insertMark("2026-01-01T00:00:59.000Z", "REJECTED");
  assert.equal(await requeueRejectedMark(rejected), true);

  const row = await markStatus(rejected);
  assert.equal(row.status, "PENDING");
  assert.equal(row.claimed_by, null);

  assert.equal(
    await requeueRejectedMark(rejected),
    false,
    "re-queueing a mark that is no longer REJECTED reports false"
  );
});

test("readOutboundQueueSummary reports claimed rows as in flight", async () => {
  const before = await readOutboundQueueSummary();
  await insertMark("2026-01-01T00:00:50.000Z");
  await insertMark("2026-01-01T00:00:51.000Z");

  await claimPendingUploads(2, "edge-one", 60_000);

  const after = await readOutboundQueueSummary();
  assert.equal(after.inFlight - before.inFlight, 2);
  assert.equal(
    after.pending,
    before.pending,
    "the two claimed rows left PENDING and are now IN_FLIGHT"
  );
});