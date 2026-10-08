import { pool } from "../db/pool";
import {
  EligibleAttendanceSession,
  MarkedAttendance,
} from "../types/attendanceSession";
import {
  enqueueAttendanceMark,
  enqueueCloudSessionMark,
} from "./syncOutboundQueueStore";

export type EligibleAttendanceResult =
  | { ok: true; data: EligibleAttendanceSession[] }
  | { ok: false; code: "STUDENT_NOT_FOUND" };

interface EligibleSessionRow {
  session_id: string;
  course_offering_id: string;
  course_code: string;
  course_title: string;
  start_time: Date;
  end_time: Date;
  late_threshold_minutes: number;
  attendance_status: "PRESENT" | "LATE" | null;
  source: "LOCAL" | "CLOUD";
  session_sync_id: string | null;
}

function toEligibleSession(row: EligibleSessionRow): EligibleAttendanceSession {
  return {
    id: Number(row.session_id),
    courseOfferingId: Number(row.course_offering_id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    lateThresholdMinutes: row.late_threshold_minutes,
    currentAttendanceState: row.attendance_status ?? "NOT_MARKED",
    source: row.source,
    sessionSyncId: row.session_sync_id,
  };
}

export async function getEligibleAttendanceSessions(
  userId: number
): Promise<EligibleAttendanceResult> {
  const studentResult = await pool.query(
    `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const studentRow = studentResult.rows[0];
  if (!studentRow) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }
  const studentId = Number(studentRow.id);

  // LOCAL sessions: the lecturer-created sessions on the edge's own tables, as
  // before. `source` + `session_sync_id` are additive so the client can tell
  // them apart from cloud sessions.
  const localResult = await pool.query(
    `SELECT s.id AS session_id, s.course_offering_id,
            c.course_code, c.title AS course_title,
            s.start_time, s.end_time,
            (EXTRACT(EPOCH FROM s.late_threshold) / 60)::int AS late_threshold_minutes,
            ar.status AS attendance_status,
            'LOCAL' AS source,
            s.sync_id AS session_sync_id
     FROM attendance_sessions s
     JOIN course_offerings o ON o.id = s.course_offering_id
     JOIN courses c ON c.id = o.course_id
     JOIN course_registrations cr
       ON cr.course_offering_id = o.id
      AND cr.student_id = $1
      AND cr.status = 'ENROLLED'
     LEFT JOIN attendance_records ar
       ON ar.session_id = s.id
      AND ar.student_id = $1
     WHERE o.status = 'OPEN'
       AND c.status = 'ACTIVE'
       AND s.status = 'ACTIVE'
       AND s.start_time <= now()
       AND now() <= s.end_time
     ORDER BY s.start_time DESC, s.id DESC`,
    [studentId]
  );

  // CLOUD sessions: the cloud-created sessions mirrored into the projection
  // (migration 023). They pass the SAME local authorization gate as local
  // sessions - the projection is joined to the local `course_offerings` by the
  // server-derived `cloud_course_offering_sync_id`, then the offering must be
  // OPEN, the course ACTIVE and the student ENROLLED. One row per session: the
  // student's mark state is read from the outbound queue's NULL-record row, since
  // a cloud session has no local `attendance_records` row to carry it.
  const cloudResult = await pool.query(
    `SELECT ps.cloud_session_id AS session_id,
            ps.cloud_course_offering_id AS course_offering_id,
            ps.course_code, ps.course_title,
            ps.start_time, ps.end_time,
            ps.late_threshold_minutes,
            q.mark_status AS attendance_status,
            'CLOUD' AS source,
            ps.cloud_sync_id AS session_sync_id
     FROM sync_attendance_sessions ps
     JOIN course_offerings o ON o.sync_id = ps.cloud_course_offering_sync_id
     JOIN courses c ON c.id = o.course_id
     JOIN course_registrations cr
       ON cr.course_offering_id = o.id
      AND cr.student_id = $1
      AND cr.status = 'ENROLLED'
     LEFT JOIN sync_outbound_attendance_marks q
       ON q.session_sync_id = ps.cloud_sync_id
      AND q.student_id = $1
      AND q.attendance_record_id IS NULL
     WHERE ps.status = 'ACTIVE'
       AND ps.start_time <= now()
       AND now() <= ps.end_time
       AND o.status = 'OPEN'
       AND c.status = 'ACTIVE'
     ORDER BY ps.start_time DESC, ps.cloud_session_id DESC`,
    [studentId]
  );

  const sessions = [...localResult.rows, ...cloudResult.rows]
    .map((row) => toEligibleSession(row as EligibleSessionRow))
    .sort(
      (a, b) => b.startTime.localeCompare(a.startTime) || b.id - a.id
    );
  return { ok: true, data: sessions };
}

// ---------------------------------------------------------------------------
// Attendance marking (authoritative write path)
// ---------------------------------------------------------------------------

export type MarkAttendanceErrorCode =
  | "STUDENT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "OFFERING_NOT_OPEN"
  | "COURSE_NOT_ACTIVE"
  | "STUDENT_NOT_REGISTERED"
  | "ALREADY_MARKED";

export type MarkAttendanceResult =
  | { ok: true; data: MarkedAttendance }
  | { ok: false; code: MarkAttendanceErrorCode };

const UNIQUE_VIOLATION_CODE = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

interface MarkSessionRow {
  id: string;
  course_offering_id: string;
  session_sync_id: string;
  course_code: string;
  course_title: string;
  offering_status: string;
  course_status: string;
  session_status: string;
  is_active_window: boolean;
  calculated_status: "PRESENT" | "LATE";
}

export async function markAttendance(
  userId: number,
  attendanceSessionId: number
): Promise<MarkAttendanceResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const studentResult = await client.query(
      `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const studentRow = studentResult.rows[0];
    if (!studentRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }
    const studentId = Number(studentRow.id);

    // Lock the session row so two concurrent markings for the same session are
    // serialized. All authoritative time checks use the database clock (now()).
    const sessionResult = await client.query(
      `SELECT s.id, s.course_offering_id, s.sync_id AS session_sync_id,
              c.course_code, c.title AS course_title,
              o.status AS offering_status, c.status AS course_status,
              s.status AS session_status,
              (s.start_time <= now() AND now() <= s.end_time) AS is_active_window,
              CASE WHEN now() <= s.start_time + s.late_threshold
                   THEN 'PRESENT' ELSE 'LATE' END AS calculated_status
       FROM attendance_sessions s
       JOIN course_offerings o ON o.id = s.course_offering_id
       JOIN courses c ON c.id = o.course_id
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [attendanceSessionId]
    );
    const sessionRow = sessionResult.rows[0] as MarkSessionRow | undefined;
    if (!sessionRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SESSION_NOT_FOUND" };
    }

    if (
      sessionRow.session_status !== "ACTIVE" ||
      !sessionRow.is_active_window
    ) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SESSION_NOT_ACTIVE" };
    }
    if (sessionRow.offering_status !== "OPEN") {
      await client.query("ROLLBACK");
      return { ok: false, code: "OFFERING_NOT_OPEN" };
    }
    if (sessionRow.course_status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "COURSE_NOT_ACTIVE" };
    }

    const registrationResult = await client.query(
      `SELECT 1 FROM course_registrations
       WHERE student_id = $1 AND course_offering_id = $2 AND status = 'ENROLLED'
       LIMIT 1`,
      [studentId, Number(sessionRow.course_offering_id)]
    );
    if ((registrationResult.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_REGISTERED" };
    }

    const inserted = await client.query(
      `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
       VALUES ($1, $2, $3, now())
       RETURNING id, marked_at`,
      [attendanceSessionId, studentId, sessionRow.calculated_status]
    );

    // Task 3: queue the mark for the cloud in the SAME transaction. If this throws
    // the whole marking request rolls back, so the edge can never hold a mark that
    // is not queued - which would silently lose attendance data on the next uplink.
    const queueId = await enqueueAttendanceMark(
      client,
      Number(inserted.rows[0].id)
    );
    if (queueId === null) {
      // The record was just inserted in this transaction, so this is unreachable
      // rather than an expected condition. Rolling back is the safe response.
      await client.query("ROLLBACK");
      return { ok: false, code: "SESSION_NOT_FOUND" };
    }

    await client.query("COMMIT");

    const record = inserted.rows[0];
    return {
      ok: true,
      data: {
        id: Number(record.id),
        attendanceSessionId: Number(sessionRow.id),
        studentId,
        status: sessionRow.calculated_status,
        markedAt: record.marked_at.toISOString(),
        courseCode: sessionRow.course_code,
        courseTitle: sessionRow.course_title,
        source: "LOCAL",
        sessionSyncId: sessionRow.session_sync_id,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      return { ok: false, code: "ALREADY_MARKED" };
    }
    throw error;
  } finally {
    client.release();
  }
}

interface CloudMarkSessionRow {
  id: string;
  local_course_offering_id: string;
  session_sync_id: string;
  course_code: string;
  course_title: string;
  offering_status: string;
  course_status: string;
  session_status: string;
  is_active_window: boolean;
  calculated_status: "PRESENT" | "LATE";
}

/**
 * Mark a CLOUD-created attendance session (Task 4).
 *
 * Mirrors `markAttendance` exactly, except that the session lives in the
 * `sync_attendance_sessions` projection instead of the local
 * `attendance_sessions` table, and there is therefore no canonical local
 * attendance record. The authorization gate is identical - authenticated student,
 * ACTIVE cloud session in its window, LOCAL offering OPEN, LOCAL course ACTIVE,
 * student ENROLLED - all checked against server-side state.
 *
 * The mark itself is enqueued for the cloud with a NULL `attendance_record_id`
 * (migration 023); the partial unique index makes a duplicate or a race resolve
 * to exactly one queue row, and a second attempt becomes ALREADY_MARKED. No cloud
 * request ever happens here: the uploader drains the queue later, so an edge with
 * no uplink marks a cloud session exactly like a local one.
 */
export async function markAttendanceOnCloudSession(
  userId: number,
  sessionSyncId: string
): Promise<MarkAttendanceResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const studentResult = await client.query(
      `SELECT id, matric_number FROM students WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const studentRow = studentResult.rows[0];
    if (!studentRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_FOUND" };
    }
    const studentId = Number(studentRow.id);
    const matricNumber = studentRow.matric_number as string;

    // Lock the projection row so concurrent markings for the same session are
    // serialized, and resolve the LOCAL offering the cloud session belongs to.
    // The cloud integer `cloud_course_offering_id` is NEVER used for an
    // authorization check or as a local id; only the local offering reached
    // through the server-derived sync id is.
    const sessionResult = await client.query(
      `SELECT ps.cloud_session_id AS id,
              o.id AS local_course_offering_id,
              ps.cloud_sync_id AS session_sync_id,
              ps.course_code, ps.course_title,
              o.status AS offering_status, c.status AS course_status,
              ps.status AS session_status,
              (ps.start_time <= now() AND now() <= ps.end_time) AS is_active_window,
              CASE WHEN now() <= ps.start_time + (ps.late_threshold_minutes * interval '1 minute')
                   THEN 'PRESENT' ELSE 'LATE' END AS calculated_status
       FROM sync_attendance_sessions ps
       JOIN course_offerings o ON o.sync_id = ps.cloud_course_offering_sync_id
       JOIN courses c ON c.id = o.course_id
       WHERE ps.cloud_sync_id = $1
       FOR UPDATE OF ps`,
      [sessionSyncId]
    );
    const sessionRow = sessionResult.rows[0] as CloudMarkSessionRow | undefined;
    if (!sessionRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SESSION_NOT_FOUND" };
    }

    if (
      sessionRow.session_status !== "ACTIVE" ||
      !sessionRow.is_active_window
    ) {
      await client.query("ROLLBACK");
      return { ok: false, code: "SESSION_NOT_ACTIVE" };
    }
    if (sessionRow.offering_status !== "OPEN") {
      await client.query("ROLLBACK");
      return { ok: false, code: "OFFERING_NOT_OPEN" };
    }
    if (sessionRow.course_status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "COURSE_NOT_ACTIVE" };
    }

    const registrationResult = await client.query(
      `SELECT 1 FROM course_registrations
       WHERE student_id = $1 AND course_offering_id = $2 AND status = 'ENROLLED'
       LIMIT 1`,
      [studentId, Number(sessionRow.local_course_offering_id)]
    );
    if ((registrationResult.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "STUDENT_NOT_REGISTERED" };
    }

    const queued = await enqueueCloudSessionMark(
      client,
      sessionRow.session_sync_id,
      studentId,
      matricNumber,
      sessionRow.calculated_status,
      new Date()
    );
    if (queued === null) {
      // The partial unique index absorbed a duplicate (including a concurrent
      // marking that committed between our SELECT and the INSERT).
      await client.query("ROLLBACK");
      return { ok: false, code: "ALREADY_MARKED" };
    }

    await client.query("COMMIT");

    // `id`/`attendanceSessionId` are informational: the cloud_session_id. The
    // addressing identity is `sessionSyncId`; the client must never address a
    // cloud session by its integer id.
    return {
      ok: true,
      data: {
        id: Number(sessionRow.id),
        attendanceSessionId: Number(sessionRow.id),
        studentId,
        status: sessionRow.calculated_status,
        markedAt: queued.markTime,
        courseCode: sessionRow.course_code,
        courseTitle: sessionRow.course_title,
        source: "CLOUD",
        sessionSyncId: sessionRow.session_sync_id,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      return { ok: false, code: "ALREADY_MARKED" };
    }
    throw error;
  } finally {
    client.release();
  }
}