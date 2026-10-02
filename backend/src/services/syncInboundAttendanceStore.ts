import type { PoolClient } from "pg";
import { pool } from "../db/pool";

/**
 * The cloud's receiving end for attendance marks uploaded from an edge (Task 4).
 *
 * The asymmetry with the rest of the synchronization design is deliberate and is
 * the whole point of Task 4: master data flows cloud -> edge and the edge mirrors
 * it, but attendance flows edge -> cloud and the cloud is authoritative. So this
 * service does not apply a payload onto a projection. It writes the canonical
 * `attendance_records` row, resolving the edge's references through the master's
 * identities (session `sync_id`, student `matric_number`).
 *
 * It also is not written in terms of the change feed. An attendance mark is a
 * COMMAND ("this student was marked late at 09:14"), not a state to mirror. Putting
 * it in the feed would mean the cloud echoing its own records back to the edge and
 * teaching the edge to apply its own decisions - so uploads use a direct endpoint
 * instead, while the feed keeps its single job of carrying master data outward.
 */

export type InboundMarkStatus = "PRESENT" | "LATE";

export interface InboundAttendanceMark {
  queueId: string;
  sessionSyncId: string;
  matricNumber: string;
  status: InboundMarkStatus;
  markedAt: string;
}

export type InboundMarkOutcome =
  | { queueId: string; result: "ACCEPTED"; cloudRecordId: number }
  | { queueId: string; result: "REJECTED"; reason: string };

/**
 * Apply one upload batch.
 *
 * Each mark is applied in its OWN transaction, and a failure or a rejection of one
 * mark never rolls back the marks already accepted in the same batch. That is the
 * correct unit of atomicity here: the edge holds one durable queue row per mark and
 * acknowledges each one individually, so collapsing a batch would either lose the
 * accepted marks or force the edge to retry work that already succeeded.
 *
 * Marks are processed oldest-first in the order given, and the caller reads the
 * queue in that same order, so a partially-failed batch converges in submission
 * order.
 */
export async function applyInboundAttendanceMarks(
  marks: InboundAttendanceMark[]
): Promise<InboundMarkOutcome[]> {
  const outcomes: InboundMarkOutcome[] = [];
  for (const mark of marks) {
    outcomes.push(await applyInboundAttendanceMark(mark));
  }
  return outcomes;
}

/**
 * Apply a single mark, returning ACCEPTED or REJECTED.
 *
 * Never throws for a mark-level problem. An unresolvable session, an unknown
 * student, or an unenrolled student are ordinary, expected outcomes of a lagging
 * edge, and they must be reported back as rejections rather than as a failed
 * request - the edge then parks the row where an operator can see it (Task 6)
 * instead of retrying forever against a request that can never succeed.
 */
export async function applyInboundAttendanceMark(
  mark: InboundAttendanceMark
): Promise<InboundMarkOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency check first. A retry of an already-accepted delivery must return
    // the ORIGINAL cloud record id and must not touch attendance_records again, or
    // a lost response would silently restate the marked_at timestamp.
    const existing = await client.query(
      `SELECT cloud_record_id
       FROM sync_inbound_attendance_receipts
       WHERE queue_id = $1`,
      [mark.queueId]
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return {
        queueId: mark.queueId,
        result: "ACCEPTED",
        cloudRecordId: Number(existing.rows[0].cloud_record_id),
      };
    }

    const session = await client.query(
      `SELECT id, course_offering_id
       FROM attendance_sessions
       WHERE sync_id = $1`,
      [mark.sessionSyncId]
    );
    if (session.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        queueId: mark.queueId,
        result: "REJECTED",
        reason:
          "The cloud does not have this attendance session. It was probably marked " +
          "against a session the cloud has not received from the edge yet.",
      };
    }
    const sessionId = Number(session.rows[0].id);
    const courseOfferingId = Number(session.rows[0].course_offering_id);

    const student = await client.query(
      `SELECT id FROM students WHERE matric_number = $1`,
      [mark.matricNumber]
    );
    if (student.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        queueId: mark.queueId,
        result: "REJECTED",
        reason:
          "The cloud does not have a student with this matriculation number. " +
          "Students are not synchronized, so it must be imported on the cloud.",
      };
    }
    const studentId = Number(student.rows[0].id);

    // The cloud's enrolment is the authority on who may be marked. An edge that
    // registers a student locally does not thereby grant the cloud permission to
    // invent an attendance record for them.
    const enrollment = await client.query(
      `SELECT 1
       FROM course_registrations
       WHERE student_id = $1 AND course_offering_id = $2`,
      [studentId, courseOfferingId]
    );
    if (enrollment.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        queueId: mark.queueId,
        result: "REJECTED",
        reason:
          "The student is not enrolled in this offering on the cloud, so the mark " +
          "cannot be recorded.",
      };
    }

    // Keyed on (session, student): re-stating a mark - a lecturer correcting an
    // error on the edge - updates the canonical record rather than creating a
    // second one, because two PRESENT rows for one student in one session is not a
    // meaningful state.
    const record = await client.query(
      `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (session_id, student_id) DO UPDATE SET
         status = EXCLUDED.status,
         marked_at = EXCLUDED.marked_at
       RETURNING id`,
      [sessionId, studentId, mark.status, mark.markedAt]
    );
    const cloudRecordId = Number(record.rows[0].id);

    await client.query(
      `INSERT INTO sync_inbound_attendance_receipts
         (queue_id, cloud_record_id, matric_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (queue_id) DO NOTHING`,
      [mark.queueId, cloudRecordId, mark.matricNumber]
    );

    await client.query("COMMIT");
    return { queueId: mark.queueId, result: "ACCEPTED", cloudRecordId };
  } catch (error) {
    // A genuine failure (connection loss, a constraint we did not anticipate).
    // Roll back so no partial state survives, and report it as a rejection so the
    // edge keeps the row PENDING and visible rather than marking it terminal.
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Roll back without masking the original error.
 *
 * A rollback that itself fails (the usual cause: the connection is already broken)
 * must not replace the real failure with a confusing "connection terminated"
 * from the middle of an error handler.
 */
export async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The transaction is already gone; nothing to undo.
  }
}