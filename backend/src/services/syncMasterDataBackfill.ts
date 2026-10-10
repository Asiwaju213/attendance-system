import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { syncConfig } from "../config/sync";
import type { SyncEntityType, SyncOperation } from "../types/sync";
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
  appendStudentDeviceEvent,
  appendStudentEvent,
} from "./syncMasterDataEmitters";

/**
 * Provider-side publication of current master data into the change feed.
 *
 * The feed is a log of things that CHANGE. Rows that pre-dated the feed - the
 * master data, students, registrations and device states that migrations 013,
 * 019, 020 and 021 gave identities IN PLACE - have no change event, and nothing
 * automatically publishes them. An edge replaying the feed from cursor 0 could
 * therefore synchronize nothing at all (master data) or, worse, synchronize
 * everything EXCEPT a specific row and report itself healthy (a skewed student -
 * the original incident behind this module).
 *
 * This module makes that publication a property of the system rather than of an
 * operator's memory:
 *
 *   - `publishMasterData("all")` emits every current row (the old manual
 *     backfill behavior - re-runnable, with the edge absorbing duplicates).
 *   - `publishMasterData("missing")` emits only rows that have NEVER been
 *     emitted, which is the safe re-run and the mode used when seeding.
 *   - `seedFeedIfNeeded()` runs `publishMasterData("missing")` exactly once,
 *     guarded by the `sync_feed_publication_state` singleton marker in the SAME
 *     transaction as the emissions, so the marker can never be set before the
 *     events it stands for have committed, and two provider instances racing at
 *     startup cannot both seed.
 *
 * Every emission goes through the same emitters the live application paths use,
 * so a backfilled payload is byte-for-byte the shape a live change would carry
 * and the edge needs no special case for "initial state".
 *
 * Entities are emitted in dependency order (a parent before anything that
 * references it), because the edge applies events in cursor order and cannot
 * write a child until its parents exist. The operation is `UPDATED`, never
 * `CREATED`: from the edge's point of view this is not a transition, and the
 * appliers do not branch on the operation for master data.
 */

export type PublicationMode = "all" | "missing";

export interface PublicationReport {
  mode: PublicationMode;
  total: number;
  perTable: Array<{ table: string; entityType: SyncEntityType; published: number }>;
}

type Emitter = (
  client: PoolClient,
  operation: SyncOperation,
  id: number
) => Promise<void>;

interface PublicationTarget {
  table: string;
  entityType: SyncEntityType;
  emit: Emitter;
}

/** The one ordered list both publication modes walk. */
const TARGETS: readonly PublicationTarget[] = [
  { table: "faculties", entityType: "faculty", emit: appendFacultyEvent },
  { table: "departments", entityType: "department", emit: appendDepartmentEvent },
  { table: "levels", entityType: "level", emit: appendLevelEvent },
  {
    table: "academic_sessions",
    entityType: "academic_session",
    emit: appendAcademicSessionEvent,
  },
  { table: "semesters", entityType: "semester", emit: appendSemesterEvent },
  { table: "courses", entityType: "course", emit: appendCourseEvent },
  {
    table: "course_offerings",
    entityType: "course_offering",
    emit: appendCourseOfferingEvent,
  },
  { table: "lecturers", entityType: "lecturer", emit: appendLecturerEvent },
  // Students come after the departments and levels they reference: the edge must
  // hold a department and a level before it can write a student row.
  { table: "students", entityType: "student", emit: appendStudentEvent },
  // Device states after their students: a device event resolves its student by
  // UUID and never creates one.
  { table: "student_devices", entityType: "student_device", emit: appendStudentDeviceEvent },
  // Registrations after both parents: a registration event resolves the student
  // AND the offering by UUID.
  {
    table: "course_registrations",
    entityType: "course_registration",
    emit: appendCourseRegistrationEvent,
  },
];

/**
 * The ids to publish for one target.
 *
 * `missing` publishes a row only when no feed event for its `sync_id` exists.
 * `entity_id` is a TEXT column and `sync_id` is a UUID, so the join compares
 * the UUID cast to text. `Order BY id` keeps the publish order stable across
 * runs, so two publishes of the same data produce the same relative order.
 */
async function idsToPublish(
  client: PoolClient,
  target: PublicationTarget,
  mode: PublicationMode
): Promise<number[]> {
  if (mode === "all") {
    const result = await client.query(
      `SELECT id FROM ${target.table} ORDER BY id ASC`
    );
    return result.rows.map((row) => Number(row.id));
  }

  const result = await client.query(
    `SELECT e.id
       FROM ${target.table} e
       LEFT JOIN sync_change_events ev
         ON ev.entity_type = $1 AND ev.entity_id = e.sync_id::text
      WHERE ev.event_id IS NULL
      ORDER BY e.id ASC`,
    [target.entityType]
  );
  return result.rows.map((row) => Number(row.id));
}

/** Publish one target's rows on the CALLER's (open, transactional) client. */
async function publishTarget(
  client: PoolClient,
  target: PublicationTarget,
  mode: PublicationMode
): Promise<number> {
  const ids = await idsToPublish(client, target, mode);
  for (const id of ids) {
    await target.emit(client, "UPDATED", id);
  }
  return ids.length;
}

/**
 * Publish current master data, in its own transaction.
 *
 * A failure rolls the whole publish back: a partial backfill served to an edge
 * would be applied as a dependency-broken batch and stall its cursor, so there
 * is no "as much as worked" outcome. Re-runnable - `missing` mode exists so a
 * repeat run does not grow the feed.
 */
export async function publishMasterData(
  mode: PublicationMode
): Promise<PublicationReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await publishMasterDataOn(client, mode);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Publish using an already-open, already-transactional client.
 *
 * Exported for the seeder, which needs the emissions and the "seeded" marker to
 * commit together.
 */
export async function publishMasterDataOn(
  client: PoolClient,
  mode: PublicationMode
): Promise<PublicationReport> {
  const perTable: PublicationReport["perTable"] = [];
  let total = 0;

  for (const target of TARGETS) {
    const published = await publishTarget(client, target, mode);
    perTable.push({
      table: target.table,
      entityType: target.entityType,
      published,
    });
    total += published;
  }

  return { mode, total, perTable };
}

/** Current publication state, or a not-yet-seeded singleton state when absent. */
export interface FeedPublicationState {
  seeded: boolean;
  seededAt: string | null;
  lastReconcileAt: string | null;
}

export async function readPublicationState(): Promise<FeedPublicationState> {
  const result = await pool.query(
    `SELECT seeded_at, last_reconcile_at FROM sync_feed_publication_state WHERE id = true`
  );
  const row = result.rows[0];
  if (!row) {
    return { seeded: false, seededAt: null, lastReconcileAt: null };
  }
  return {
    seeded: row.seeded_at !== null,
    seededAt: row.seeded_at ? new Date(row.seeded_at as Date).toISOString() : null,
    lastReconcileAt: row.last_reconcile_at
      ? new Date(row.last_reconcile_at as Date).toISOString()
      : null,
  };
}

/**
 * Publish the current master data exactly once.
 *
 * The singleton row is locked FOR UPDATE so two provider instances racing at
 * startup serialize on it: the first publishes and stamps `seeded_at`, the
 * second reads the stamp inside the same lock and runs nothing. Because the
 * stamp and the emissions share one transaction, a crash mid-publish rolls both
 * back and the next startup retries.
 */
export async function seedFeedIfNeeded(): Promise<{ ran: boolean; total: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO sync_feed_publication_state (id) VALUES (true)
       ON CONFLICT (id) DO NOTHING`
    );
    const state = await client.query(
      `SELECT seeded_at FROM sync_feed_publication_state WHERE id = true FOR UPDATE`
    );
    if (state.rows[0]?.seeded_at !== null) {
      await client.query("COMMIT");
      return { ran: false, total: 0 };
    }

    const report = await publishMasterDataOn(client, "missing");
    await client.query(
      `UPDATE sync_feed_publication_state SET seeded_at = now() WHERE id = true`
    );
    await client.query("COMMIT");
    return { ran: true, total: report.total };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The provider startup hook.
 *
 * Safe to call on every boot and in every deployment: it returns immediately
 * unless this process is a configured provider outside `NODE_ENV=test`, the
 * publish-on-startup switch is on, and the feed has not been seeded yet. It
 * never throws at the caller - a failed seed is logged and retried on the next
 * startup, which is the correct behavior for a maintenance step that must not
 * take an edge or a provider down.
 */
export async function maybePublishMasterDataOnStartup(): Promise<void> {
  if (syncConfig.consumer.enabled) {
    return;
  }
  if (syncConfig.provider.secretHash === null) {
    return;
  }
  if (!syncConfig.provider.publishOnStartup) {
    console.log(
      "Sync feed seeding disabled by SYNC_PUBLISH_ON_STARTUP=false. Pre-existing rows must be published manually."
    );
    return;
  }
  if (process.env.NODE_ENV === "test") {
    return;
  }

  try {
    const result = await seedFeedIfNeeded();
    console.log(
      result.ran
        ? `Published ${result.total} master-data feed events for pre-existing rows.`
        : "Sync feed already seeded; no master-data rows needed publishing."
    );
  } catch (error) {
    console.error(
      "Master-data feed seed failed and will be retried on the next startup. " +
        `Message: ${(error as Error).message}`
    );
  }
}