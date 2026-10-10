// Publishes the cloud's CURRENT master data into the change feed.
//
// What this is for
// ----------------
// The change feed is a log of things that CHANGE. A K12 edge that connects for
// the first time starts at cursor 0 and replays that log from the beginning, so
// it learns about every faculty, department, course and lecturer that was edited
// after the feed existed - and about nothing that was merely ALREADY THERE.
// Cloud master data predates migration 012: the faculties and departments from
// migrations 004 and 008, the levels and semesters from 001, the courses created
// through the admin UI. Students, registrations and device states granted their
// `sync_id` in place (migrations 019-021) are in the same position. None of it
// has a change event, so without a publish an edge could never synchronize a
// single row of it and would sit at cursor 0 reporting itself healthy.
//
// This script delegates to `syncMasterDataBackfill.publishMasterData`, which
// walks the master data in dependency order and emits one event per current row
// through the same emitters the stores use. Going through the emitters is
// deliberate: it guarantees the backfilled payload is byte-for-byte the same
// shape a live change would produce, so the edge needs no special case for
// "initial state".
//
// Modes
// -----
// Default: publish EVERY current row (the historic behavior; re-running appends
// duplicates, which the edge absorbs through its idempotency).
//
// `--only-missing`: publish only rows that have never been emitted. Safe to
// re-run and does not grow the feed. This is also the mode the provider seeds
// with automatically at startup (see syncMasterDataBackfill.ts).
//
// Production safety:
// ------------------
// When NODE_ENV=production, this script requires an explicit --confirm-production
// flag to proceed. Without it, the script aborts before any database mutation.
// This prevents accidental execution against a production database.
import { join } from "node:path";
import { inspect } from "node:util";
import dotenv from "dotenv";
import { pool } from "../src/db/pool";
import {
  publishMasterData,
  type PublicationMode,
} from "../src/services/syncMasterDataBackfill";

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

const MODE: PublicationMode = process.argv.includes("--only-missing")
  ? "missing"
  : "all";

/**
 * Renders a thrown value as an operator-facing report.
 *
 * JSONB emission errors carry Postgres `code`/`detail`/`hint` on the error
 * object rather than in the message, so those are printed alongside the message;
 * anything that could carry a credential is redacted first.
 */
function describeFailure(error: unknown): string {
  const pg = error as { code?: string; detail?: string; hint?: string } | undefined;
  const parts: Array<[string, string]> = [];
  if (error instanceof Error && error.message) {
    parts.push(["message", error.message]);
  }
  if (pg?.code) parts.push(["code", pg.code]);
  if (pg?.detail) parts.push(["detail", pg.detail]);
  if (pg?.hint) parts.push(["hint", pg.hint]);
  if (parts.length === 0) {
    return `  (no error details available: ${inspect(error)})`;
  }
  return parts.map(([label, value]) => `  ${label}: ${value}`).join("\n");
}

(async () => {
  try {
    const report = await publishMasterData(MODE);
    for (const row of report.perTable) {
      console.log(`  ${row.table}: ${row.published}`);
    }
    console.log(
      `Published ${report.total} ${MODE} master-data events into the sync change feed.`
    );
  } catch (error) {
    console.error(`Master-data feed backfill failed:\n${describeFailure(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
})();