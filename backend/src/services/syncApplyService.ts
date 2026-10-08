import { pool } from "../db/pool";
import { SYNC_ATTENDANCE_SESSION_VERSION, SYNC_PAYLOAD_VERSION } from "../config/sync";
import type { SyncChangeEvent, SyncedAttendanceSession } from "../types/sync";
import {
  applyMasterDataEvent,
  isMasterDataEntityType,
  isRetiredEntityType,
} from "./syncMasterDataAppliers";
import { SyncApplyError } from "./syncErrors";

export { SyncApplyError };

/**
 * Applies cloud change events to the local K12 edge database.
 *
 * The correctness argument for the whole synchronization design lives in this
 * file, so it is worth stating plainly:
 *
 *   Every event is applied, the local cursor is advanced, and the processed-event
 *   receipts are recorded inside ONE local transaction.
 *
 * Because those three writes commit together, there is no window in which the
 * edge has applied an event without recording that it did, or has recorded a
 * cursor it did not actually reach. A crash can therefore only ever cause work
 * to be REDONE (which the receipt table absorbs) or NOTHING. Events can never be
 * silently skipped, which is the failure mode that would be invisible from both
 * sides.
 */

/**
 * A refusal to apply a batch that is internally inconsistent.
 *
 * Thrown instead of applying "as much as looks safe", because a partial apply
 * would move the cursor past events that were never applied.
 *
 * Re-exported from `syncErrors` so existing importers of this module keep
 * working, while the class itself lives somewhere both the apply service and the
 * appliers can depend on without importing each other.
 */

export interface SyncApplyResult {
  applied: number;
  /** Events already present in the receipt table; applied as no-ops. */
  skipped: number;
  cursor: number;
}

/**
 * Read this edge's durable cursor, creating the row on first use.
 *
 * A missing row means the edge has never synchronized, which is cursor 0 rather
 * than an error. The row is created with INSERT ... ON CONFLICT DO NOTHING so two
 * workers racing on a fresh database cannot collide.
 */
export async function readCursor(consumerId: string): Promise<number> {
  const existing = await pool.query(
    `SELECT last_cursor FROM sync_consumer_state WHERE consumer_id = $1`,
    [consumerId]
  );
  const row = existing.rows[0];
  if (row) {
    return Number(row.last_cursor);
  }

  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
     VALUES ($1, 0)
     ON CONFLICT (consumer_id) DO NOTHING`,
    [consumerId]
  );
  return 0;
}

/**
 * Verify the batch is a strictly ascending, gap-free continuation of the cursor.
 *
 * A gap is treated as an error rather than skipped over. The cloud feed is
 * append-only and is not pruned, so a gap can only mean events were lost or
 * removed upstream; continuing past it would make the edge permanently
 * inconsistent while still reporting success. Surfacing the gap is the honest
 * outcome, and it is recoverable (an operator can reset the edge cursor once the
 * upstream loss is understood) rather than silent.
 */
function assertContiguous(
  events: SyncChangeEvent[],
  cursor: number
): void {
  let expected = cursor + 1;
  for (const event of events) {
    if (event.cursor !== expected) {
      throw new SyncApplyError(
        expected > event.cursor
          ? `Cloud sync feed went backwards: expected cursor ${expected} but received ${event.cursor}.`
          : `Cursor gap detected: expected cursor ${expected} but received ${event.cursor}.`
      );
    }
    expected += 1;
  }
}

/** A session payload that cannot be stored as-is. */
function assertUsableSession(payload: SyncedAttendanceSession): void {
  if (
    payload.version !== SYNC_PAYLOAD_VERSION &&
    payload.version !== SYNC_ATTENDANCE_SESSION_VERSION
  ) {
    throw new SyncApplyError(
      `Cloud attendance_session payload version ${payload.version} is not supported.`
    );
  }
  const numeric = [
    payload.cloudSessionId,
    payload.cloudCourseOfferingId,
    payload.cloudLecturerId,
  ];
  if (numeric.some((value) => !Number.isFinite(value))) {
    throw new SyncApplyError(
      "Cloud attendance session payload is missing a numeric identifier."
    );
  }
  if (
    typeof payload.syncId !== "string" ||
    payload.syncId === "" ||
    typeof payload.startTime !== "string" ||
    typeof payload.endTime !== "string" ||
    (payload.status !== "ACTIVE" && payload.status !== "ENDED")
  ) {
    throw new SyncApplyError(
      "Cloud attendance session payload is missing required fields."
    );
  }
}

/**
 * Apply one batch inside a single local transaction.
 *
 * An empty batch is a no-op that leaves the cursor alone, so an idle poll never
 * touches the database beyond reading the cursor.
 */
export async function applyChangeBatch(
  consumerId: string,
  events: SyncChangeEvent[]
): Promise<SyncApplyResult> {
  if (events.length === 0) {
    return { applied: 0, skipped: 0, cursor: await readCursor(consumerId) };
  }

  // Validate the whole batch before opening a transaction, so an obviously bad
  // payload costs nothing and cannot leave a partial state to reason about.
  for (const event of events) {
    if (event.entityType === "attendance_session") {
      assertUsableSession(event.payload as SyncedAttendanceSession);
    } else if (isRetiredEntityType(event.entityType)) {
      // Nothing to check: the payload describes a table migration 018 dropped.
    } else if (!isMasterDataEntityType(event.entityType)) {
      // Refusing is deliberate. Skipping an entity type this edge does not
      // understand would advance the cursor past data it never applied.
      throw new SyncApplyError(
        `Unsupported sync entity type "${event.entityType}". The edge cannot advance its cursor past an entity it does not understand.`
      );
    }
  }

  const client = await pool.connect();
  // Declared outside the try so the catch can name the event that failed.
  let currentEvent: SyncChangeEvent | null = null;
  try {
    await client.query("BEGIN");

    const state = await client.query(
      `SELECT last_cursor FROM sync_consumer_state
       WHERE consumer_id = $1
       FOR UPDATE`,
      [consumerId]
    );
    const stateRow = state.rows[0];
    if (!stateRow) {
      throw new SyncApplyError(
        `No sync cursor row exists for consumer "${consumerId}".`
      );
    }

    const cursor = Number(stateRow.last_cursor);
    assertContiguous(events, cursor);

    let applied = 0;
    let skipped = 0;

    for (const event of events) {
      currentEvent = event;
      // Claim the event first. The unique (consumer_id, event_id) primary key is
      // the idempotency guarantee: a re-delivered event conflicts here, returns
      // no row, and is skipped without touching the session.
      const claim = await client.query(
        `INSERT INTO sync_processed_events (consumer_id, event_id, cursor)
         VALUES ($1, $2, $3)
         ON CONFLICT (consumer_id, event_id) DO NOTHING
         RETURNING event_id`,
        [consumerId, event.eventId, event.cursor]
      );

      if ((claim.rowCount ?? 0) === 0) {
        skipped += 1;
        continue;
      }

      if (isRetiredEntityType(event.entityType)) {
        // Claimed above, so the cursor moves on and a re-delivery is still
        // skipped; nothing is written because the entity no longer exists.
        applied += 1;
        continue;
      }

      if (isMasterDataEntityType(event.entityType)) {
        await applyMasterDataEvent(client, event);
        applied += 1;
        continue;
      }

      const session = event.payload as SyncedAttendanceSession;
      // Upsert rather than insert: every event carries the complete session, so
      // applying the CREATED and then the CLOSED event for one session leaves a
      // single row in the right state. source_event_cursor always records the
      // latest cloud position that wrote this row.
      await client.query(
        `INSERT INTO sync_attendance_sessions
(cloud_sync_id, cloud_session_id, cloud_course_offering_id,
             cloud_course_offering_sync_id, cloud_lecturer_id,
             course_code, course_title, lecturer_display_name, lecturer_staff_id,
             start_time, end_time,
             late_threshold_minutes, status, ended_at,
             source_event_cursor, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (cloud_sync_id) DO UPDATE SET
           cloud_session_id = EXCLUDED.cloud_session_id,
           cloud_course_offering_id = EXCLUDED.cloud_course_offering_id,
           cloud_course_offering_sync_id = EXCLUDED.cloud_course_offering_sync_id,
           cloud_lecturer_id = EXCLUDED.cloud_lecturer_id,
           course_code = EXCLUDED.course_code,
           course_title = EXCLUDED.course_title,
           lecturer_display_name = EXCLUDED.lecturer_display_name,
           lecturer_staff_id = EXCLUDED.lecturer_staff_id,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           late_threshold_minutes = EXCLUDED.late_threshold_minutes,
           status = EXCLUDED.status,
           ended_at = EXCLUDED.ended_at,
           source_event_cursor = EXCLUDED.source_event_cursor,
           last_synced_at = now()`,
        [
          session.syncId,
          session.cloudSessionId,
          session.cloudCourseOfferingId,
          session.cloudCourseOfferingSyncId,
          session.cloudLecturerId,
          session.courseCode,
          session.courseTitle,
          session.lecturerDisplayName,
          session.lecturerStaffId,
          session.startTime,
          session.endTime,
          session.lateThresholdMinutes,
          session.status,
          session.endedAt,
          event.cursor,
        ]
      );

      applied += 1;
    }

    // The cursor moves in this same transaction as the writes above. It is never
    // advanced anywhere else, which is what guarantees it cannot outrun the data.
    const lastCursor = events[events.length - 1].cursor;
    await client.query(
      `UPDATE sync_consumer_state
       SET last_cursor = $2, updated_at = now()
       WHERE consumer_id = $1`,
      [consumerId, lastCursor]
    );

    await client.query("COMMIT");
    return { applied, skipped, cursor: lastCursor };
  } catch (error) {
    // Roll back the applied events, the receipts AND the cursor together. The
    // previously stored cursor is what remains, so the next attempt re-reads the
    // same range.
    await client.query("ROLLBACK").catch(() => undefined);

    // A missing parent is the one failure an operator will hit for real, and the
    // raw foreign-key message does not say which edge entity is missing or from
    // which event. Naming both is the difference between a five-minute fix and an
    // afternoon of log reading.
    if ((error as { code?: string }).code === "23503" || (error as { code?: string }).code === "23502") {
      throw new SyncApplyError(
        `Cannot apply cloud sync event ${currentEvent?.eventId ?? "(unknown)"} ` +
          `(${currentEvent?.entityType ?? "unknown entity"} at cursor ${currentEvent?.cursor ?? "?"}): ` +
          `a referenced parent (faculty, department, level, course, academic session, semester, course offering or student) is not present on this edge. ` +
          `The cloud emits a parent's CREATED event before anything that references it, so this normally means the edge cursor was advanced past it.`
      );
    }

    throw error;
  } finally {
    client.release();
  }
}