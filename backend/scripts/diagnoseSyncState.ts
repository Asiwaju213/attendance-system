// Read-only synchronization state diagnostic (Workstream C).
//
// WHY THIS EXISTS
// ---------------
// The ad-hoc scripts it replaces (tmp_diag.ts, checkMissingStudentFeedEvent.ts)
// each answered one hardcoded question. This one answers, in a single report,
// the questions an operator actually asks when sync looks wrong, without
// touching a single row:
//
//   1. Is any consumer cursor inconsistent with its processed-event receipts?
//   2. Is the outbound attendance queue stuck (stale claims, retrying marks)?
//   3. Are any master-data entities missing from the change feed?
//   4. Does the change feed itself have cursor gaps?
//
// HARD GUARANTEES
// ---------------
// - Runs inside BEGIN READ ONLY. There is no write path in this file at all.
// - Prints nothing secret: the database host/name only, never credentials.
// - Recommends recovery actions but never performs them. In particular it
//   NEVER resets a cursor, truncates or rewrites the feed, or edits identities:
//   the remediations it hints at are the append-only publisher
//   (scripts/backfillMasterDataFeed.ts) and the admin stale-claim release
//   endpoint, both of which are safe on their own.
//
// USAGE
// -----
//   npx tsx scripts/diagnoseSyncState.ts
//   npx tsx scripts/diagnoseSyncState.ts --entity student
//   npx tsx scripts/diagnoseSyncState.ts --entity student --sync-id <uuid>
//
// --entity narrows the feed-coverage section to one entity type; --sync-id
// narrows it to one synchronization identity.

import { join } from "node:path";
import dotenv from "dotenv";
import { pool } from "../src/db/pool";
import {
  countStaleUploadClaims,
  readOutboundQueueSummary,
} from "../src/services/syncOutboundQueueStore";
import { DEFAULT_CLAIM_TIMEOUT_MS, syncConfig } from "../src/config/sync";
import {
  formatDatabaseTarget,
  resolveDatabaseTarget,
} from "./rebuildCloudSyncFeed";

const MASTER_DATA_TABLES: ReadonlyArray<{ entityType: string; table: string }> = [
  { entityType: "faculty", table: "faculties" },
  { entityType: "department", table: "departments" },
  { entityType: "level", table: "levels" },
  { entityType: "academic_session", table: "academic_sessions" },
  { entityType: "semester", table: "semesters" },
  { entityType: "course", table: "courses" },
  { entityType: "course_offering", table: "course_offerings" },
  { entityType: "lecturer", table: "lecturers" },
  { entityType: "student", table: "students" },
  { entityType: "student_device", table: "student_devices" },
  { entityType: "student_device_bootstrap", table: "student_device_bootstraps" },
  { entityType: "course_registration", table: "course_registrations" },
];

interface CliArgs {
  entity: string | null;
  syncId: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { entity: null, syncId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--entity") {
      args.entity = argv[i + 1] ?? null;
      i += 1;
    } else if (argv[i] === "--sync-id") {
      args.syncId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return args;
}

function printHeader(role: string, cursorHint: string): void {
  console.log("==================================================");
  console.log("Sync state diagnostic (READ ONLY)");
  console.log("==================================================");
  console.log(`Database target : ${cursorHint}`);
  console.log(`Detected role   : ${role}`);
  console.log("");
}

function printSection(title: string): void {
  console.log("--------------------------------------------------");
  console.log(title);
  console.log("--------------------------------------------------");
}

async function diagnoseCursors(): Promise<void> {
  printSection("1. Consumer cursors vs processed-event receipts");
  const result = await pool.query(
    `SELECT c.consumer_id,
            c.last_cursor::bigint,
            c.updated_at,
            (SELECT count(*)::int
               FROM sync_processed_events p
              WHERE p.consumer_id = c.consumer_id)                         AS receipt_count,
            (SELECT min(p.cursor)::bigint
               FROM sync_processed_events p
              WHERE p.consumer_id = c.consumer_id)                         AS receipt_min,
            (SELECT max(p.cursor)::bigint
               FROM sync_processed_events p
              WHERE p.consumer_id = c.consumer_id)                         AS receipt_max,
            (SELECT count(DISTINCT p.cursor)::bigint
               FROM sync_processed_events p
              WHERE p.consumer_id = c.consumer_id)                         AS distinct_cursors,
            (SELECT count(*)::bigint
               FROM sync_processed_events p
              WHERE p.consumer_id = c.consumer_id
                AND p.cursor > c.last_cursor)                              AS ahead_of_cursor
     FROM sync_consumer_state c
     ORDER BY c.consumer_id`
  );

  if (result.rowCount === 0) {
    console.log("No consumer state rows: this sync never recorded a cursor.");
    return;
  }

  for (const row of result.rows) {
    const consumer = String(row.consumer_id);
    const lastCursor = Number(row.last_cursor);
    const count = Number(row.receipt_count);
    const minCursor = Number(row.receipt_min ?? 0);
    const maxCursor = Number(row.receipt_max ?? 0);
    const distinct = Number(row.distinct_cursors ?? 0);
    const ahead = Number(row.ahead_of_cursor ?? 0);

    console.log(`consumer=${consumer} last_cursor=${lastCursor} receipts=${count} range=${count > 0 ? `${minCursor}..${maxCursor}` : "n/a"} (distinct=${distinct})`);

    const issues: string[] = [];
    if (count > 0 && distinct !== maxCursor) {
      issues.push(
        `interior receipt gap: distinct cursors (${distinct}) != highest cursor (${maxCursor})`
      );
    }
    if (ahead > 0) {
      issues.push(`${ahead} receipt(s) at cursor positions above last_cursor - the cursor was moved back or wedged`);
    }
    if (lastCursor < maxCursor) {
      issues.push(`last_cursor=${lastCursor} is below the highest applied receipt (${maxCursor})`);
    }
    if (lastCursor > maxCursor && count > 0) {
      issues.push(`last_cursor=${lastCursor} is above every applied receipt (${maxCursor})`);
    }
    if (lastCursor < 0) {
      issues.push("last_cursor is negative - invalid");
    }

    if (issues.length === 0) {
      console.log("  OK: cursor and receipts are consistent.");
    } else {
      for (const issue of issues) {
        console.log(`  WARNING: ${issue}.`);
      }
      console.log(
        "  Do NOT reset the cursor to recover. Fix the upstream feed first (see the feed sections below)."
      );
    }
  }
}

async function diagnoseOutboundQueue(): Promise<void> {
  printSection("2. Outbound attendance queue");
  const claimTtlMs = syncConfig.consumer.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;

  const byStatus = await pool.query(
    `SELECT status, count(*)::int AS n
       FROM sync_outbound_attendance_marks
      GROUP BY status
      ORDER BY MIN(queued_at), status`
  );
  const counts = new Map<string, number>();
  for (const row of byStatus.rows) {
    counts.set(String(row.status), Number(row.n));
  }

  const summary = await readOutboundQueueSummary();
  const stale = await countStaleUploadClaims(claimTtlMs);

  console.log(
    `status counts: PENDING=${counts.get("PENDING") ?? 0} IN_FLIGHT=${counts.get("IN_FLIGHT") ?? 0} ` +
      `SENT=${counts.get("SENT") ?? 0} REJECTED=${counts.get("REJECTED") ?? 0}`
  );
  console.log(
    `retrying (PENDING with attempts>0): ${summary.retrying}; ` +
      `stale IN_FLIGHT older than ${claimTtlMs}ms: ${stale}`
  );
  console.log(`oldest pending: ${summary.oldestPendingAt ?? "(none)"}`);
  console.log(`last sent: ${summary.lastSentAt ?? "(never)"}`);
  console.log(`last error: ${summary.lastError ?? "(none)"}`);

  if (stale > 0) {
    console.log(
      "  WARNING: stale upload claims detected. The uploading process is dead or stopped;"
    );
    console.log(
      "  recover with POST /api/admin/sync-outbound/release-stale-claims (or restart the edge worker)."
    );
  }
  if ((counts.get("REJECTED") ?? 0) > 0) {
    console.log(
      "  NOTE: rejected marks are parked for a human. Requeue individually via the admin API once the cause is fixed."
    );
  }
}

async function diagnoseFeedCoverage(args: CliArgs): Promise<void> {
  printSection("3. Master-data / session feed coverage");
  const all = args.entity === null;
  const entries = all
    ? [
        ...MASTER_DATA_TABLES,
        { entityType: "attendance_session", table: "attendance_sessions" },
      ]
    : [
        ...MASTER_DATA_TABLES.filter((e) => e.entityType === args.entity),
        ...(args.entity === "attendance_session"
          ? [{ entityType: "attendance_session", table: "attendance_sessions" }]
          : []),
      ];

  if (entries.length === 0) {
    console.log(`Unknown entity type "${args.entity}". Nothing to check.`);
    return;
  }

  let foundProblem = false;
  for (const { entityType, table } of entries) {
    const tableCheck = await pool.query(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [table]
    );
    if (!tableCheck.rows[0].exists) {
      console.log(`${entityType} (${table}): table not present in this database - skipping.`);
      continue;
    }

    if (args.syncId !== null) {
      const one = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM sync_change_events e
            WHERE e.entity_type = $1 AND e.entity_id = $2
         ) AS has_event`,
        [entityType, args.syncId]
      );
      console.log(
        `${entityType} sync_id=${args.syncId}: ${one.rows[0].has_event ? "has feed event(s)" : "NO feed event"}`
      );
      if (!one.rows[0].has_event) {
        foundProblem = true;
      }
      continue;
    }

    const coverage = await pool.query(
      `WITH per_row AS (
         SELECT t.sync_id::text AS sid,
                EXISTS (
                  SELECT 1 FROM sync_change_events e
                   WHERE e.entity_type = $1 AND e.entity_id = t.sync_id::text
                ) AS has_event
         FROM ${table} t
       )
       SELECT (SELECT count(*)::int FROM per_row)            AS total,
              (SELECT count(*)::int FROM per_row
                WHERE NOT has_event)                          AS no_events,
              (SELECT (array_agg(sid ORDER BY sid))::text[]   AS s
                 FROM (SELECT sid FROM per_row WHERE NOT has_event LIMIT 5) x) AS examples`,
      [entityType]
    );
    const row = coverage.rows[0];
    const total = Number(row.total);
    const noEvents = Number(row.no_events);
    const examples = (row.examples as string[] | null) ?? [];

    if (total === 0) {
      console.log(`${entityType} (${table}): 0 rows.`);
    } else {
      console.log(
        `${entityType} (${table}): ${total} row(s), ${noEvents} with NO feed event${examples.length > 0 ? `, e.g. ${examples.join(", ")}` : ""}`
      );
    }
    if (noEvents > 0) {
      foundProblem = true;
    }
  }

  if (foundProblem) {
    console.log("");
    console.log(
      "  REMEDIATION (append-only only): run `npx tsx scripts/backfillMasterDataFeed.ts` to publish"
    );
    console.log(
      "  the missing events. Do NOT truncate the feed or reset the edge cursor to recover."
    );
  }
}

async function diagnoseFeedGaps(): Promise<void> {
  printSection("4. Change feed cursor integrity");
  const result = await pool.query(
    `SELECT count(*)::int AS n,
            min(cursor)::bigint AS min_cursor,
            max(cursor)::bigint AS max_cursor,
            count(DISTINCT cursor)::bigint AS distinct_cursors
       FROM sync_change_events`
  );
  const row = result.rows[0];
  const n = Number(row.n);
  const minCursor = Number(row.min_cursor ?? 0);
  const maxCursor = Number(row.max_cursor ?? 0);
  const distinct = Number(row.distinct_cursors ?? 0);

  if (n === 0) {
    console.log("Feed is empty (0 events).");
    return;
  }
  const expected = maxCursor - minCursor + 1;
  const gaps = expected - distinct;
  console.log(`events=${n} cursor range=${minCursor}..${maxCursor} distinct=${distinct}`);
  if (gaps === 0) {
    console.log("  OK: cursor sequence has no interior gaps.");
  } else {
    console.log(`  WARNING: ${gaps} interior cursor position(s) missing.`);
    console.log(
      "  A gap means events were lost or purged upstream. Do not reset the edge cursor to"
    );
    console.log(
      "  skip it: resolve the upstream feed first, then the edge may need an operator-led republish."
    );
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "This script must not run with NODE_ENV=test. It is an operational diagnostic, not part of the test suite."
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const target = resolveDatabaseTarget(process.env);
  printHeader(
    syncConfig.provider.secretHash !== null ? "PROVIDER (cloud)" : "EDGE / CONSUMER",
    formatDatabaseTarget(target)
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await diagnoseCursors();
    await diagnoseOutboundQueue();
    await diagnoseFeedCoverage(args);
    await diagnoseFeedGaps();
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  dotenv.config({
    path: join(__dirname, "..", ".env"),
    override: false,
    quiet: true,
  });
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error("Diagnostic failed.");
      if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error(String(error));
      }
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}