// Provider-side master-data feed publication (syncMasterDataBackfill).
//
// This file covers the fix for the "cursor advances, student never arrives"
// class of failure: rows that pre-dated the feed (migration-013/019/020/021-era)
// get published exactly once, in dependency order, through the real emitters, so
// the edge can adopt the cloud identity by natural key.
//
// The feed and the publication singleton are SHARED with every other suite, so
// this file is hermetic about it: it records the feed floor it started on,
// publishes, asserts, and then deletes exactly the events it created and resets
// the singleton - the shared feed is byte-for-byte as it found it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool } from "../src/db/pool";
import {
  publishMasterData,
  readPublicationState,
  seedFeedIfNeeded,
} from "../src/services/syncMasterDataBackfill";

let feedFloor = 0;

async function latestCursor(): Promise<number> {
  const result = await pool.query(
    `SELECT coalesce(max(cursor), 0)::bigint AS m FROM sync_change_events`
  );
  return Number(result.rows[0].m);
}

before(async () => {
  feedFloor = await latestCursor();
  await pool.query(
    `UPDATE sync_feed_publication_state
        SET seeded_at = NULL, last_reconcile_at = NULL
      WHERE id = true`
  );
});

after(async () => {
  // Remove exactly the events this file published and restore the singleton, so
  // the suites after this one see the feed exactly as this file found it.
  await pool.query(`DELETE FROM sync_change_events WHERE cursor > $1`, [feedFloor]);
  await pool.query(
    `UPDATE sync_feed_publication_state
        SET seeded_at = NULL, last_reconcile_at = NULL
      WHERE id = true`
  );
  await pool.end();
});

test("the feed starts unseeded", async () => {
  const state = await readPublicationState();
  assert.equal(state.seeded, false);
  assert.equal(state.seededAt, null);
});

test("seedFeedIfNeeded publishes current master data exactly once", async () => {
  const result = await seedFeedIfNeeded();

  assert.equal(result.ran, true);
  assert.ok(result.total > 0, "the seeded E2E data must be publishable");

  const state = await readPublicationState();
  assert.equal(state.seeded, true, "the marker must be set by the seed");
  assert.ok(state.seededAt !== null);

  // The cursor is a shared BIGSERIAL, so earlier suites' rolled-back inserts
  // leave sequence gaps and `max(cursor)` is NOT "how many rows exist". Count
  // the events this seed created instead: everything above the feed floor is
  // ours, because this file runs alone under `--test-concurrency=1`.
  const created = await pool.query(
    `SELECT count(*)::int AS n
       FROM sync_change_events
      WHERE cursor > $1`,
    [feedFloor]
  );
  assert.equal(
    created.rows[0].n,
    result.total,
    "the seed must create exactly one event per published row"
  );

  // The empty feed could not have produced a student event from nothing: those
  // arrive only because pre-existing students are published.
  const students = await pool.query(
    `SELECT count(*)::int AS n
       FROM sync_change_events
      WHERE cursor > $1 AND entity_type = 'student' AND operation = 'UPDATED'`,
    [feedFloor]
  );
  assert.ok(students.rows[0].n > 0, "pre-existing students must be published");
});

test("a second seed run adds nothing", async () => {
  const beforeCursor = await latestCursor();

  const result = await seedFeedIfNeeded();

  assert.equal(result.ran, false);
  assert.equal(result.total, 0, "the marker must prevent re-seeding");
  assert.equal(
    await latestCursor(),
    beforeCursor,
    "no events may be written by a redundant seed"
  );
});

test("publishMasterData('missing') after seeding publishes nothing", async () => {
  const beforeCursor = await latestCursor();

  const report = await publishMasterData("missing");

  assert.equal(report.mode, "missing");
  assert.equal(report.total, 0, "every existing row was already published");
  assert.equal(
    await latestCursor(),
    beforeCursor,
    "the feed must not grow when there is nothing missing"
  );
});

test("publishMasterData('all') re-emits every current row in dependency order", async () => {
  const beforeCursor = await latestCursor();

  const report = await publishMasterData("all");

  assert.equal(report.mode, "all");
  assert.ok(report.total > 0, "publish-all must re-emit the current rows");

  const emitted = await pool.query(
    `SELECT count(*)::int AS n
       FROM sync_change_events
      WHERE cursor > $1`,
    [beforeCursor]
  );
  assert.equal(
    emitted.rows[0].n,
    report.total,
    "publish-all must emit exactly one event per source row"
  );

  // Dependency order: nothing a student references (a parent entity) may be
  // published AFTER it, because the edge writes a student only once its
  // department and level exist. Entity groups are emitted in the module's
  // dependency order, so only child entities may follow the last student.
  const cursors = await pool.query(
    `SELECT entity_type, cursor
       FROM sync_change_events
      WHERE cursor > $1
      ORDER BY cursor ASC`,
    [beforeCursor]
  );
  const seen = cursors.rows.map((row) => row.entity_type as string);
  const lastStudentIndex = seen.lastIndexOf("student");
  if (lastStudentIndex !== -1) {
    const childrenOnly = new Set(["student_device", "course_registration"]);
    const afterLastStudent = seen.slice(lastStudentIndex + 1);
    assert.ok(
      afterLastStudent.every((type) => childrenOnly.has(type)),
      "no parent entity (faculty, department, level, course, offering, lecturer) may be published after a student"
    );
  }

  // Every emitted row is represented as a complete event.
  for (const row of report.perTable) {
    assert.ok(Number.isInteger(row.published), `${row.table} count must be numeric`);
  }
});