// Publishes the cloud's CURRENT master data into the change feed.
//
// Why this has to exist
// ---------------------
// The change feed is a log of things that CHANGE. A K12 edge that connects for
// the first time starts at cursor 0 and replays that log from the beginning, so
// it learns about every faculty, department, course and lecturer that was edited
// after the feed existed - and about nothing that was merely ALREADY THERE.
// Cloud master data predates migration 012: the faculties and departments from
// migrations 004 and 008, the levels and semesters from 001, the courses created
// through the admin UI. None of it has a change event, so without this script an
// edge could never synchronize a single row of it and would sit at cursor 0
// reporting itself healthy.
//
// This script walks the master data in dependency order and appends one event
// per existing row, using the same emitters the stores use. Going through the
// emitters rather than assembling payloads here is deliberate: it guarantees the
// backfilled payload is byte-for-byte the same shape a live change would produce,
// so the edge needs no special case for "initial state".
//
// It is safe to run more than once. Re-running appends duplicate events, which
// the edge absorbs through its existing idempotency (each is applied, then the
// upsert writes the same values again), so the only cost of a repeat run is feed
// length. Run it once after adding master data out of band (an import, a data
// migration, a restore from backup), not on a schedule.
//
// Production safety:
// ------------------
// When NODE_ENV=production, this script requires an explicit --confirm-production
// flag to proceed. Without it, the script aborts before any database mutation.
// This prevents accidental execution against a production database.
import type { PoolClient } from "pg";
import { join } from "node:path";
import dotenv from "dotenv";
import type { SyncOperation } from "../src/types/sync";
import { pool } from "../src/db/pool";
import {
  appendAcademicSessionEvent,
  appendAttendanceNetworkEvent,
  appendCourseEvent,
  appendCourseOfferingEvent,
  appendDepartmentEvent,
  appendFacultyEvent,
  appendLevelEvent,
  appendLocationEvent,
  appendLecturerEvent,
  appendSemesterEvent,
} from "../src/services/syncMasterDataEmitters";

dotenv.config({
  path: join(__dirname, "..", ".env"),
  override: false,
  quiet: true,
});

/**
 * Determines whether we are running in a production context and whether the
 * required confirmation flag is present.
 *
 * The backfill must not silently mutate a production database. In production
 * (NODE_ENV=production), the caller MUST pass --confirm-production on the
 * command line. Without it, the script aborts with a clear message before any BEGIN.
 */
function assertProductionConfirmed(): void {
  const isProduction = process.env.NODE_ENV === "production";
  const hasConfirmFlag = process.argv.includes("--confirm-production");

  if (isProduction && !hasConfirmFlag) {
    console.error(
      "ERROR: Refusing to run backfill in production without explicit confirmation.\n" +
        "This script will write events to the sync change feed of the database\n" +
        "configured by your environment variables.\n\n" +
        "To proceed, re-run with:\n" +
        "  npx tsx scripts/backfillMasterDataFeed.ts --confirm-production\n\n" +
        "For non-production environments, the flag is not required."
    );
    process.exit(1);
  }

  // Additional safety: refuse to run against a test database when not in test mode.
  // The test database is isolated by NODE_ENV=test and discrete DATABASE_* vars.
  if (process.env.NODE_ENV === "test") {
    console.error(
      "ERROR: This script should not be run with NODE_ENV=test.\n" +
        "Test runs use an isolated test database; backfill there serves no purpose."
    );
    process.exit(1);
  }
}

assertProductionConfirmed();

/**
 * Dependency order, and the order cursors are assigned in.
 *
 * This is the same order the appliers need parents in, and it is the reason the
 * backfill runs as one transaction: the edge applies events in cursor order, so
 * every parent is guaranteed to appear before the first child that references it.
 *
 * Every emitter is published as `UPDATED` rather than `CREATED`. The operation
 * describes the transition, and from the edge's point of view this is not a
 * transition at all: the row either does not exist on the edge yet or is
 * identical to what it already holds. The appliers do not branch on the operation
 * for master data precisely so that either value is safe, and `UPDATED` is the
 * honest description of a full state publication.
 */
type MasterDataEmitter = (
  client: PoolClient,
  operation: SyncOperation,
  id: number
) => Promise<void>;

const EMITTERS: ReadonlyArray<{ table: string; emit: MasterDataEmitter }> = [
  { table: "faculties", emit: appendFacultyEvent },
  { table: "departments", emit: appendDepartmentEvent },
  { table: "levels", emit: appendLevelEvent },
  { table: "academic_sessions", emit: appendAcademicSessionEvent },
  { table: "semesters", emit: appendSemesterEvent },
  { table: "courses", emit: appendCourseEvent },
  { table: "course_offerings", emit: appendCourseOfferingEvent },
  { table: "locations", emit: appendLocationEvent },
  { table: "attendance_networks", emit: appendAttendanceNetworkEvent },
  { table: "lecturers", emit: appendLecturerEvent },
];

(async () => {
  const client = await pool.connect();
  let total = 0;

  try {
    await client.query("BEGIN");

    for (const { table, emit } of EMITTERS) {
      // `id` ordering is stable and gives the edge a deterministic sequence, so
      // two backfills of the same data produce the same relative order.
      const ids = await client.query(`SELECT id FROM ${table} ORDER BY id ASC`);

      for (const row of ids.rows) {
        await emit(client, "UPDATED", Number(row.id));
        total += 1;
      }

      console.log(`  ${table}: ${ids.rows.length}`);
    }

    await client.query("COMMIT");
    console.log(`Backfilled ${total} master-data events into the sync change feed.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((error) => {
  console.error("Master-data feed backfill failed:", (error as Error).message);
  process.exit(1);
});