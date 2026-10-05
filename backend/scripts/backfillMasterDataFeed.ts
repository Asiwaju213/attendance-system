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
import { inspect } from "node:util";
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

/**
 * The PostgreSQL server's own fields on a failed query.
 *
 * `pg` attaches these to the error object rather than folding them into the
 * message, and they are usually the whole diagnosis: `code` says what went
 * wrong, `detail` says which row, and `hint` says what to do about it.
 */
type PostgresErrorFields = {
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  routine?: string;
  position?: string;
  where?: string;
};

/**
 * Masks anything credential-shaped before it is printed.
 *
 * Connection failures quote the host and port, which is worth keeping because it
 * is what distinguishes a bad host from a rejected login. But a `DATABASE_URL`
 * that reached a message would carry the password with it, so the userinfo and
 * any `password=` pair are replaced.
 */
function redact(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^/\s@]*@/gi, "$1[redacted]@")
    .replace(/(password\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]");
}

/**
 * Renders a thrown value as an operator-facing report.
 *
 * The first production attempt reported an empty message, because a bare
 * `error.message` prints nothing at all for a rejection that is not an `Error`,
 * and throws away the code, detail and hint that identify a PostgreSQL failure.
 * Everything that can identify the failure is printed; anything that could carry
 * a credential is redacted first.
 */
function describeFailure(error: unknown): string {
  const pg = error as PostgresErrorFields | undefined;

  const fields: Array<[string, unknown]> =
    error instanceof Error
      ? [
          ["name", error.name],
          ["message", error.message],
          ["code", pg?.code],
          ["severity", pg?.severity],
          ["detail", pg?.detail],
          ["hint", pg?.hint],
          ["schema", pg?.schema],
          ["table", pg?.table],
          ["column", pg?.column],
          ["dataType", pg?.dataType],
          ["constraint", pg?.constraint],
          ["routine", pg?.routine],
          ["position", pg?.position],
          ["where", pg?.where],
          ["stack", error.stack],
        ]
      : [
          ["name", "not an Error instance"],
          ["value", inspect(error)],
        ];

  const lines = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `  ${label}: ${redact(String(value))}`);

  return lines.length > 0 ? lines.join("\n") : "  (no error details available)";
}

(async () => {
  let client: PoolClient | null = null;
  let total = 0;

  try {
    client = await pool.connect();

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
    // Only a client that actually connected has a transaction to roll back; a
    // failed `pool.connect()` never opened one.
    if (client !== null) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        console.error(
          "ROLLBACK also failed, so the server may already have aborted the transaction:\n" +
            describeFailure(rollbackError)
        );
        return undefined;
      });
    }
    throw error;
  } finally {
    client?.release();
    // Cleanup must never replace the failure that got us here, so a pool that
    // refuses to close is reported and the original error still propagates.
    await pool.end().catch((poolError: unknown) => {
      console.error(
        "Closing the database pool failed:\n" + describeFailure(poolError)
      );
      return undefined;
    });
  }
})().catch((error: unknown) => {
  console.error("Master-data feed backfill failed:\n" + describeFailure(error));
  process.exit(1);
});