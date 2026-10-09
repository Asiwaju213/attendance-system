// Rebuilds the cloud's sync change feed from current database state.
//
// Why this has to exist
// ---------------------
// The change feed is a log of things that CHANGE. A K12 edge that connects for
// the first time starts at cursor 0 and replays that log from the beginning.
// If the feed is missing events for rows that already existed when the feed was
// created (e.g. master data seeded by migrations before the feed existed), the
// edge can never learn about those rows and sits at cursor 0 forever.
//
// The backfill script (backfillMasterDataFeed.ts) APPENDS events for existing
// rows, but it cannot fix a feed whose existing events are out of dependency
// order (a child event appearing before its parent). This script REPLACES the
// entire feed: it truncates sync_change_events and re-emits every row in
// dependency order, so the resulting feed is a clean, replayable log that an
// edge starting at cursor 0 can consume without gaps.
//
// Safety:
// -------
// - Preflight validates ALL source rows before any write. If any row cannot
//   be represented as a complete event, the script aborts without touching
//   the feed.
// - The write phase runs in a single transaction: TRUNCATE + all emissions
//   commit together or roll back together.
// - Production requires BOTH --confirm and --confirm-production flags.
// - Dry-run mode (--preflight) runs in a READ ONLY transaction and writes
//   nothing.
//
// Usage:
//   npx tsx scripts/rebuildCloudSyncFeed.ts --preflight
//   npx tsx scripts/rebuildCloudSyncFeed.ts --confirm
//   npx tsx scripts/rebuildCloudSyncFeed.ts --confirm --confirm-production  # production only

import type { PoolClient } from "pg";
import { join } from "node:path";
import { inspect } from "node:util";
import dotenv from "dotenv";
import type { SyncEntityType, SyncOperation } from "../src/types/sync";
import { pool } from "../src/db/pool";
import {
  SESSION_SELECT,
  lecturerDisplay,
} from "../src/services/attendanceSessionStore";
import {
  appendAcademicSessionEvent,
  appendCourseEvent,
  appendCourseOfferingEvent,
  appendCourseRegistrationEvent,
  appendDepartmentEvent,
  appendFacultyEvent,
  appendLevelEvent,
  appendLecturerEvent,
  appendSemesterEvent,
  appendStudentDeviceBootstrapEvent,
  appendStudentDeviceEvent,
  appendStudentEvent,
} from "../src/services/syncMasterDataEmitters";
import {
  appendAttendanceSessionEvent,
  type AttendanceSessionEventInput,
} from "../src/services/syncChangeEventStore";

// ---------------------------------------------------------------------------
// Database target resolution (pure, unit-testable)
// ---------------------------------------------------------------------------

export interface DatabaseTarget {
  hostname: string;
  databaseName: string;
  source: "DATABASE_URL" | "discrete";
}

function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function resolveDatabaseTarget(
  env: NodeJS.ProcessEnv
): DatabaseTarget {
  const connectionString = readOptionalEnv(env, "DATABASE_URL");
  if (connectionString !== undefined) {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new Error(
        "Invalid DATABASE_URL: expected a postgres:// or postgresql:// connection string."
      );
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error(
        `Invalid DATABASE_URL: expected a postgres:// or postgresql:// scheme, got "${url.protocol}".`
      );
    }
    if (url.hostname === "") {
      throw new Error("Invalid DATABASE_URL: no database host was given.");
    }
    if (url.pathname === "" || url.pathname === "/") {
      throw new Error("Invalid DATABASE_URL: no database name was given.");
    }
    return {
      hostname: url.hostname,
      databaseName: url.pathname.slice(1),
      source: "DATABASE_URL",
    };
  }

  const host = readOptionalEnv(env, "DATABASE_HOST");
  const database = readOptionalEnv(env, "DATABASE_NAME");
  if (host !== undefined && database !== undefined) {
    return { hostname: host, databaseName: database, source: "discrete" };
  }

  throw new Error(
    "Cannot identify database target: neither DATABASE_URL nor discrete DATABASE_HOST/DATABASE_NAME are set."
  );
}

export function formatDatabaseTarget(target: DatabaseTarget): string {
  return `${target.hostname}/${target.databaseName}`;
}

// ---------------------------------------------------------------------------
// CLI decision logic (pure, unit-testable)
// ---------------------------------------------------------------------------

export type CliDecision =
  | { kind: "preflight" }
  | { kind: "write" }
  | { kind: "refuse"; message: string };

export function decideCliMode(
  argv: string[],
  nodeEnv: string | undefined
): CliDecision {
  const hasPreflight = argv.includes("--preflight");
  const hasConfirm = argv.includes("--confirm");
  const hasConfirmProduction = argv.includes("--confirm-production");

  if (hasPreflight && hasConfirm) {
    return {
      kind: "refuse",
      message:
        "--preflight and --confirm are mutually exclusive. Use --preflight for a read-only report, or --confirm to write.",
    };
  }

  if (hasConfirmProduction && !hasConfirm) {
    return {
      kind: "refuse",
      message:
        "--confirm-production requires --confirm. Both flags are needed to write.",
    };
  }

  if (nodeEnv === "test") {
    return {
      kind: "refuse",
      message:
        "This script must not run with NODE_ENV=test. Tests import its functions directly.",
    };
  }

  if (hasPreflight) {
    return { kind: "preflight" };
  }

  if (!hasConfirm) {
    return {
      kind: "refuse",
      message:
        "Refusing to run without --confirm. Use --preflight for a read-only report, or --confirm to write.",
    };
  }

  if (nodeEnv === "production" && !hasConfirmProduction) {
    return {
      kind: "refuse",
      message:
        "Refusing to run in production without --confirm-production. Re-run with both --confirm and --confirm-production.",
    };
  }

  return { kind: "write" };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export function isBlankSyncId(syncId: string | null | undefined): boolean {
  return syncId === null || syncId === undefined || syncId.trim() === "";
}

export function detectDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      dups.add(v);
    } else {
      seen.add(v);
    }
  }
  return [...dups].sort();
}

export function detectInvalidStatuses(
  rows: Array<{ id: string; status: string }>,
  allowed: readonly string[]
): Array<{ id: string; status: string }> {
  return rows.filter((r) => !allowed.includes(r.status));
}

export function findCrossEntityDuplicates(
  entries: Array<{ entityType: string; syncId: string }>
): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const { syncId } of entries) {
    if (seen.has(syncId)) {
      dups.add(syncId);
    } else {
      seen.add(syncId);
    }
  }
  return [...dups].sort();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityInventoryRow {
  id: string;
  syncId: string;
}

export interface EntityInventory {
  entityType: SyncEntityType;
  table: string;
  count: number;
  blankSyncIds: number;
  duplicateSyncIds: string[];
  invalidStatusRows: EntityInventoryRow[];
  missingParentRows: EntityInventoryRow[];
}

export interface AttendanceSessionInventory {
  count: number;
  unrepresentableRows: EntityInventoryRow[];
}

export interface PreflightReport {
  ok: boolean;
  entities: EntityInventory[];
  attendanceSessions: AttendanceSessionInventory | null;
  crossEntityDuplicateSyncIds: string[];
  expectedEventCount: number;
  problems: string[];
}

export interface RebuildWriteResult {
  totalEvents: number;
  byEntity: Record<string, number>;
  firstCursor: number;
  lastCursor: number;
}

export class RebuildPreflightError extends Error {
  constructor(
    message: string,
    public readonly report: PreflightReport
  ) {
    super(message);
    this.name = "RebuildPreflightError";
  }
}

// ---------------------------------------------------------------------------
// Entity configuration
// ---------------------------------------------------------------------------

interface EntityConfig {
  entityType: SyncEntityType;
  table: string;
  idExpr: string;
  statusColumn: string | null;
  allowedStatuses: readonly string[] | null;
  missingParentSql: string | null;
}

const ENTITY_CONFIGS: readonly EntityConfig[] = [
  {
    entityType: "faculty",
    table: "faculties",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["ACTIVE", "INACTIVE"],
    missingParentSql: null,
  },
  {
    entityType: "department",
    table: "departments",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["ACTIVE", "INACTIVE"],
    missingParentSql: `SELECT d.id::text AS id, d.sync_id::text AS sync_id FROM departments d LEFT JOIN faculties f ON f.id = d.faculty_id WHERE f.id IS NULL`,
  },
  {
    entityType: "level",
    table: "levels",
    idExpr: "id::text",
    statusColumn: null,
    allowedStatuses: null,
    missingParentSql: null,
  },
  {
    entityType: "academic_session",
    table: "academic_sessions",
    idExpr: "id::text",
    statusColumn: null,
    allowedStatuses: null,
    missingParentSql: null,
  },
  {
    entityType: "semester",
    table: "semesters",
    idExpr: "id::text",
    statusColumn: null,
    allowedStatuses: null,
    missingParentSql: null,
  },
  {
    entityType: "course",
    table: "courses",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["ACTIVE", "INACTIVE"],
    missingParentSql: `SELECT c.id::text AS id, c.sync_id::text AS sync_id FROM courses c LEFT JOIN levels lv ON lv.id = c.level_id WHERE lv.id IS NULL`,
  },
  {
    entityType: "course_offering",
    table: "course_offerings",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["OPEN", "CLOSED"],
    missingParentSql: `SELECT o.id::text AS id, o.sync_id::text AS sync_id FROM course_offerings o LEFT JOIN courses c ON c.id = o.course_id LEFT JOIN academic_sessions a ON a.id = o.academic_session_id LEFT JOIN semesters s ON s.id = o.semester_id WHERE c.id IS NULL OR a.id IS NULL OR s.id IS NULL`,
  },
  {
    entityType: "lecturer",
    table: "lecturers",
    idExpr: "id::text",
    statusColumn: null,
    allowedStatuses: null,
    missingParentSql: `SELECT lec.id::text AS id, lec.sync_id::text AS sync_id FROM lecturers lec LEFT JOIN users u ON u.id = lec.user_id WHERE u.id IS NULL`,
  },
  {
    entityType: "student",
    table: "students",
    idExpr: "id::text",
    statusColumn: null,
    allowedStatuses: null,
    missingParentSql: `SELECT s.id::text AS id, s.sync_id::text AS sync_id FROM students s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN levels lv ON lv.id = s.level_id WHERE u.id IS NULL OR d.id IS NULL OR lv.id IS NULL`,
  },
  {
    entityType: "student_device",
    table: "student_devices",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["ACTIVE", "REVOKED"],
    missingParentSql: `SELECT d.id::text AS id, d.sync_id::text AS sync_id FROM student_devices d LEFT JOIN students s ON s.id = d.student_id WHERE s.id IS NULL`,
  },
  {
    entityType: "student_device_bootstrap",
    table: "student_device_bootstraps",
    idExpr: "sync_id::text",
    statusColumn: "status",
    allowedStatuses: ["PENDING", "CONSUMED"],
    missingParentSql: `SELECT b.sync_id::text AS id, b.sync_id::text AS sync_id FROM student_device_bootstraps b LEFT JOIN student_devices d ON d.id = b.device_id LEFT JOIN students s ON s.id = b.student_id WHERE d.id IS NULL OR s.id IS NULL OR b.secret_hash IS NULL OR b.secret_hash = '' OR b.expires_at IS NULL`,
  },
  {
    entityType: "course_registration",
    table: "course_registrations",
    idExpr: "id::text",
    statusColumn: "status",
    allowedStatuses: ["ENROLLED", "DROPPED", "COMPLETED"],
    missingParentSql: `SELECT r.id::text AS id, r.sync_id::text AS sync_id FROM course_registrations r LEFT JOIN students s ON s.id = r.student_id LEFT JOIN course_offerings o ON o.id = r.course_offering_id WHERE s.id IS NULL OR o.id IS NULL`,
  },
];

// For students, the status lives on the joined users row, not on students itself.
const STUDENT_STATUS_SQL = `SELECT s.id::text AS id, s.sync_id::text AS sync_id, u.status FROM students s JOIN users u ON u.id = s.user_id WHERE u.status NOT IN ('ACTIVE', 'INACTIVE', 'PENDING')`;

// ---------------------------------------------------------------------------
// Attendance session reconstruction
// ---------------------------------------------------------------------------

const SESSION_WITH_SYNC_SELECT = `
  SELECT base.*, s.sync_id
  FROM (${SESSION_SELECT}) base
  JOIN attendance_sessions s ON s.id = base.id
`;

interface SessionRow {
  id: string;
  course_offering_id: string;
  started_by_lecturer_id: string;
  course_offering_sync_id: string;
  course_code: string;
  course_title: string;
  start_time: Date;
  end_time: Date;
  late_threshold_minutes: number;
  status: "ACTIVE" | "ENDED";
  ended_at: Date | null;
  sync_id: string;
}

async function buildSessionEventInput(
  client: PoolClient,
  row: SessionRow
): Promise<AttendanceSessionEventInput> {
  const lecturer = await lecturerDisplay(
    client,
    Number(row.started_by_lecturer_id)
  );
  return {
    syncId: row.sync_id,
    cloudSessionId: Number(row.id),
    cloudLecturerId: Number(row.started_by_lecturer_id),
    session: {
      courseOfferingId: Number(row.course_offering_id),
      courseOfferingSyncId: row.course_offering_sync_id,
      courseCode: row.course_code,
      courseTitle: row.course_title,
      lecturerDisplayName: lecturer.name,
      lecturerStaffId: lecturer.staffId,
      startTime: row.start_time.toISOString(),
      endTime: row.end_time.toISOString(),
      lateThresholdMinutes: Number(row.late_threshold_minutes),
      status: row.status,
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export async function rebuildFeedPreflight(
  client: PoolClient
): Promise<PreflightReport> {
  const problems: string[] = [];
  const entities: EntityInventory[] = [];

  for (const config of ENTITY_CONFIGS) {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${config.table}`
    );
    const count = Number(countResult.rows[0].n);

    const blankResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${config.table} WHERE length(btrim(sync_id::text)) = 0`
    );
    const blankSyncIds = Number(blankResult.rows[0].n);

    const dupResult = await client.query(
      `SELECT sync_id::text AS sync_id FROM ${config.table} GROUP BY sync_id HAVING COUNT(*) > 1`
    );
    const duplicateSyncIds = dupResult.rows.map((r) => r.sync_id as string);

    let invalidStatusRows: EntityInventoryRow[] = [];
    if (config.allowedStatuses !== null) {
      if (config.entityType === "student") {
        const statusResult = await client.query(STUDENT_STATUS_SQL);
        invalidStatusRows = statusResult.rows.map((r) => ({
          id: r.id as string,
          syncId: r.sync_id as string,
        }));
      } else if (config.statusColumn !== null) {
        const placeholders = config.allowedStatuses
          .map((_, i) => `$${i + 1}`)
          .join(", ");
        const statusResult = await client.query(
          `SELECT ${config.idExpr} AS id, sync_id::text AS sync_id FROM ${config.table} WHERE ${config.statusColumn} NOT IN (${placeholders})`,
          [...config.allowedStatuses]
        );
        invalidStatusRows = statusResult.rows.map((r) => ({
          id: r.id as string,
          syncId: r.sync_id as string,
        }));
      }
    }

    let missingParentRows: EntityInventoryRow[] = [];
    if (config.missingParentSql !== null) {
      const mpResult = await client.query(config.missingParentSql);
      missingParentRows = mpResult.rows.map((r) => ({
        id: r.id as string,
        syncId: r.sync_id as string,
      }));
    }

    if (blankSyncIds > 0) {
      problems.push(
        `${config.table}: ${blankSyncIds} row(s) with blank sync_id`
      );
    }
    if (duplicateSyncIds.length > 0) {
      problems.push(
        `${config.table}: duplicate sync_id(s): ${duplicateSyncIds.join(", ")}`
      );
    }
    if (invalidStatusRows.length > 0) {
      problems.push(
        `${config.table}: ${invalidStatusRows.length} row(s) with unsupported status`
      );
    }
    if (missingParentRows.length > 0) {
      problems.push(
        `${config.table}: ${missingParentRows.length} row(s) with missing parent reference(s)`
      );
    }

    entities.push({
      entityType: config.entityType,
      table: config.table,
      count,
      blankSyncIds,
      duplicateSyncIds,
      invalidStatusRows,
      missingParentRows,
    });
  }

  // Cross-entity duplicate sync_id check
  const crossEntityParts = ENTITY_CONFIGS.map(
    (c) => `SELECT '${c.entityType}' AS entity_type, sync_id::text AS sync_id FROM ${c.table}`
  );
  const crossEntityResult = await client.query(
    `SELECT sync_id FROM (${crossEntityParts.join(" UNION ALL ")}) all_sync_ids GROUP BY sync_id HAVING COUNT(*) > 1`
  );
  const crossEntityDuplicateSyncIds = crossEntityResult.rows.map(
    (r) => r.sync_id as string
  );
  if (crossEntityDuplicateSyncIds.length > 0) {
    problems.push(
      `Cross-entity duplicate sync_id(s): ${crossEntityDuplicateSyncIds.join(", ")}`
    );
  }

  // Attendance sessions: checked first per requirement
  let attendanceSessions: AttendanceSessionInventory | null = null;
  const sessionCountResult = await client.query(
    `SELECT COUNT(*)::int AS n FROM attendance_sessions`
  );
  const sessionCount = Number(sessionCountResult.rows[0].n);

  if (sessionCount > 0) {
    const unrepresentableRows: EntityInventoryRow[] = [];

    // Sessions with missing offering or course (INNER JOIN in SESSION_SELECT
    // would drop them, so we detect them explicitly)
    const orphanResult = await client.query(
      `SELECT s.id::text AS id, s.sync_id::text AS sync_id FROM attendance_sessions s LEFT JOIN course_offerings o ON o.id = s.course_offering_id LEFT JOIN courses c ON c.id = o.course_id WHERE o.id IS NULL OR c.id IS NULL`
    );
    for (const r of orphanResult.rows) {
      unrepresentableRows.push({ id: r.id as string, syncId: r.sync_id as string });
    }

    // Sessions with invalid status
    const invalidStatusResult = await client.query(
      `SELECT id::text AS id, sync_id::text AS sync_id FROM attendance_sessions WHERE status NOT IN ('ACTIVE', 'ENDED')`
    );
    for (const r of invalidStatusResult.rows) {
      unrepresentableRows.push({ id: r.id as string, syncId: r.sync_id as string });
    }

    // Sessions whose lecturer cannot be resolved
    const sessionRows = await client.query<SessionRow>(
      `${SESSION_WITH_SYNC_SELECT} ORDER BY base.id ASC`
    );
    for (const row of sessionRows.rows) {
      try {
        await buildSessionEventInput(client, row);
      } catch {
        unrepresentableRows.push({ id: row.id, syncId: row.sync_id });
      }
    }

    if (unrepresentableRows.length > 0) {
      problems.push(
        `attendance_sessions: ${unrepresentableRows.length} row(s) cannot be fully represented as sync events`
      );
    }

    attendanceSessions = {
      count: sessionCount,
      unrepresentableRows,
    };
  }

  const expectedEventCount =
    entities.reduce((sum, e) => sum + e.count, 0) +
    (attendanceSessions?.count ?? 0);

  return {
    ok: problems.length === 0,
    entities,
    attendanceSessions,
    crossEntityDuplicateSyncIds,
    expectedEventCount,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Write phase
// ---------------------------------------------------------------------------

type MasterDataEmitter = (
  client: PoolClient,
  operation: SyncOperation,
  id: number | string
) => Promise<void>;

interface EmitStep {
  entityType: SyncEntityType;
  table: string;
  selectSql: string;
  getId: (row: { id?: string; sync_id?: string }) => number | string;
  emit: MasterDataEmitter;
}

const EMIT_STEPS: readonly EmitStep[] = [
  {
    entityType: "faculty",
    table: "faculties",
    selectSql: `SELECT id::text AS id FROM faculties ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendFacultyEvent(client, op, id as number),
  },
  {
    entityType: "department",
    table: "departments",
    selectSql: `SELECT id::text AS id FROM departments ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendDepartmentEvent(client, op, id as number),
  },
  {
    entityType: "level",
    table: "levels",
    selectSql: `SELECT id::text AS id FROM levels ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendLevelEvent(client, op, id as number),
  },
  {
    entityType: "academic_session",
    table: "academic_sessions",
    selectSql: `SELECT id::text AS id FROM academic_sessions ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) =>
      appendAcademicSessionEvent(client, op, id as number),
  },
  {
    entityType: "semester",
    table: "semesters",
    selectSql: `SELECT id::text AS id FROM semesters ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendSemesterEvent(client, op, id as number),
  },
  {
    entityType: "course",
    table: "courses",
    selectSql: `SELECT id::text AS id FROM courses ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendCourseEvent(client, op, id as number),
  },
  {
    entityType: "course_offering",
    table: "course_offerings",
    selectSql: `SELECT id::text AS id FROM course_offerings ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) =>
      appendCourseOfferingEvent(client, op, id as number),
  },
  {
    entityType: "lecturer",
    table: "lecturers",
    selectSql: `SELECT id::text AS id FROM lecturers ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendLecturerEvent(client, op, id as number),
  },
  {
    entityType: "student",
    table: "students",
    selectSql: `SELECT id::text AS id FROM students ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) => appendStudentEvent(client, op, id as number),
  },
  {
    entityType: "student_device",
    table: "student_devices",
    selectSql: `SELECT id::text AS id FROM student_devices ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) =>
      appendStudentDeviceEvent(client, op, id as number),
  },
  {
    entityType: "student_device_bootstrap",
    table: "student_device_bootstraps",
    selectSql: `SELECT sync_id FROM student_device_bootstraps ORDER BY sync_id ASC`,
    getId: (row) => row.sync_id as string,
    emit: (client, op, id) =>
      appendStudentDeviceBootstrapEvent(client, op, id as string),
  },
  {
    entityType: "course_registration",
    table: "course_registrations",
    selectSql: `SELECT id::text AS id FROM course_registrations ORDER BY id ASC`,
    getId: (row) => Number(row.id),
    emit: (client, op, id) =>
      appendCourseRegistrationEvent(client, op, id as number),
  },
];

export async function rebuildFeedWrite(
  client: PoolClient
): Promise<RebuildWriteResult> {
  await client.query("BEGIN");

  try {
    // Re-run preflight inside the transaction so the snapshot matches the write
    const report = await rebuildFeedPreflight(client);
    if (!report.ok) {
      await client.query("ROLLBACK");
      throw new RebuildPreflightError(
        `Preflight failed. The feed was NOT modified. Problems:\n  ${report.problems.join("\n  ")}`,
        report
      );
    }

    // Truncate the feed. This is transactional: if any emission fails, the
    // truncate rolls back with it.
    await client.query("TRUNCATE TABLE sync_change_events RESTART IDENTITY");

    const byEntity: Record<string, number> = {};
    let totalEvents = 0;

    // Emit master data in dependency order
    for (const step of EMIT_STEPS) {
      const rows = await client.query(step.selectSql);
      for (const row of rows.rows) {
        const id = step.getId(row);
        await step.emit(client, "UPDATED", id);
        byEntity[step.entityType] = (byEntity[step.entityType] ?? 0) + 1;
        totalEvents += 1;
      }
    }

    // Emit attendance sessions last (after all master data parents)
    if (report.attendanceSessions && report.attendanceSessions.count > 0) {
      const sessionRows = await client.query<SessionRow>(
        `${SESSION_WITH_SYNC_SELECT} ORDER BY base.id ASC`
      );
      for (const row of sessionRows.rows) {
        const input = await buildSessionEventInput(client, row);
        await appendAttendanceSessionEvent(
          client,
          "attendance_session",
          input.syncId,
          "UPDATED",
          input
        );
        byEntity["attendance_session"] =
          (byEntity["attendance_session"] ?? 0) + 1;
        totalEvents += 1;
      }
    }

    await client.query("COMMIT");

    // Read back the feed to confirm
    const feedResult = await client.query(
      `SELECT MIN(cursor)::int AS first_cursor, MAX(cursor)::int AS last_cursor, COUNT(*)::int AS n FROM sync_change_events`
    );
    const firstCursor = Number(feedResult.rows[0].first_cursor ?? 0);
    const lastCursor = Number(feedResult.rows[0].last_cursor ?? 0);

    return { totalEvents, byEntity, firstCursor, lastCursor };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Error reporting helpers (copied from backfillMasterDataFeed.ts)
// ---------------------------------------------------------------------------

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

function redact(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^/\s@]*@/gi, "$1[redacted]@")
    .replace(/(password\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]");
}

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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function printPreflightReport(report: PreflightReport): void {
  console.log("=== Cloud Sync Feed Rebuild — Preflight Report ===\n");

  console.log("Per-entity inventory:");
  for (const e of report.entities) {
    const issues: string[] = [];
    if (e.blankSyncIds > 0) issues.push(`${e.blankSyncIds} blank sync_id(s)`);
    if (e.duplicateSyncIds.length > 0)
      issues.push(`${e.duplicateSyncIds.length} duplicate sync_id(s)`);
    if (e.invalidStatusRows.length > 0)
      issues.push(`${e.invalidStatusRows.length} invalid status(es)`);
    if (e.missingParentRows.length > 0)
      issues.push(`${e.missingParentRows.length} missing parent(s)`);
    const issueStr = issues.length > 0 ? ` [ISSUES: ${issues.join("; ")}]` : "";
    console.log(`  ${e.entityType} (${e.table}): ${e.count} row(s)${issueStr}`);
  }

  if (report.attendanceSessions) {
    const s = report.attendanceSessions;
    const issueStr =
      s.unrepresentableRows.length > 0
        ? ` [ISSUES: ${s.unrepresentableRows.length} unrepresentable]`
        : "";
    console.log(
      `  attendance_session (attendance_sessions): ${s.count} row(s)${issueStr}`
    );
  } else {
    console.log("  attendance_session (attendance_sessions): 0 row(s)");
  }

  if (report.crossEntityDuplicateSyncIds.length > 0) {
    console.log(
      `\nCross-entity duplicate sync_id(s): ${report.crossEntityDuplicateSyncIds.join(", ")}`
    );
  }

  console.log(`\nExpected event count: ${report.expectedEventCount}`);

  if (report.ok) {
    console.log("\nPreflight PASSED. The feed can be safely rebuilt.");
    console.log(
      "Run with --confirm to execute the rebuild (or --confirm --confirm-production in production)."
    );
  } else {
    console.log("\nPreflight FAILED. The following problems must be resolved:");
    for (const p of report.problems) {
      console.log(`  - ${p}`);
    }
    console.log("\nThe feed was NOT modified.");
  }
}

function printWriteResult(result: RebuildWriteResult): void {
  console.log("=== Cloud Sync Feed Rebuild — Write Complete ===\n");
  console.log(`Total events written: ${result.totalEvents}`);
  console.log(`Cursor range: ${result.firstCursor}..${result.lastCursor}`);
  console.log("\nEvents per entity:");
  for (const [entity, count] of Object.entries(result.byEntity).sort()) {
    console.log(`  ${entity}: ${count}`);
  }
  console.log(
    "\nNext step: reset the edge checkpoint so the edge replays from cursor 0."
  );
  console.log(
    "See backend/scripts/resetEdgeCheckpoint.sql for the edge-only reset procedure."
  );
}

async function main(): Promise<void> {
  const decision = decideCliMode(process.argv.slice(2), process.env.NODE_ENV);

  if (decision.kind === "refuse") {
    console.error(`ERROR: ${decision.message}`);
    process.exit(1);
  }

  let client: PoolClient | null = null;

  try {
    const target = resolveDatabaseTarget(process.env);
    console.log(`Database target: ${formatDatabaseTarget(target)}`);

    client = await pool.connect();

    if (decision.kind === "preflight") {
      await client.query("BEGIN READ ONLY");
      const report = await rebuildFeedPreflight(client);
      await client.query("COMMIT");
      printPreflightReport(report);
      if (!report.ok) {
        process.exit(1);
      }
    } else {
      const result = await rebuildFeedWrite(client);
      printWriteResult(result);
    }
  } catch (error) {
    if (error instanceof RebuildPreflightError) {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    }
    console.error("Rebuild failed:\n" + describeFailure(error));
    process.exit(1);
  } finally {
    client?.release();
    await pool.end().catch((poolError: unknown) => {
      console.error(
        "Closing the database pool failed:\n" + describeFailure(poolError)
      );
    });
  }
}

// Only run the CLI when executed directly, not when imported by tests
if (require.main === module) {
  dotenv.config({
    path: join(__dirname, "..", ".env"),
    override: false,
    quiet: true,
  });
  main();
}
