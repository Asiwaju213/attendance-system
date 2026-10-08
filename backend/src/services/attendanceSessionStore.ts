import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { appendAttendanceSessionEvent } from "./syncChangeEventStore";
import {
  AdminAttendanceRecord,
  AdminAttendanceSession,
  AttendanceRecordStatus,
  AttendanceSession,
} from "../types/attendanceSession";
import { AdminAttendanceSessionFilters } from "../validation/adminAttendanceSessionValidation";
import { CreateAttendanceSessionInput } from "../validation/lecturerAttendanceSessionValidation";

export type CreateSessionErrorCode =
  | "LECTURER_NOT_FOUND"
  | "OFFERING_NOT_FOUND"
  | "OFFERING_NOT_OPEN"
  | "COURSE_NOT_ACTIVE"
  | "LECTURER_NOT_ASSIGNED"
  | "ACTIVE_SESSION_EXISTS";

export type CreateSessionResult =
  | { ok: true; data: AttendanceSession }
  | { ok: false; code: CreateSessionErrorCode };

export type ListSessionsResult =
  | { ok: true; data: AttendanceSession[] }
  | { ok: false; code: "LECTURER_NOT_FOUND" };

export type EndSessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_ALREADY_ENDED"
  | "SESSION_EXPIRED";

export type EndSessionResult =
  | { ok: true; data: AttendanceSession }
  | { ok: false; code: EndSessionErrorCode };

interface SessionRow {
  id: string;
  course_offering_id: string;
  // Read so a synchronization event can name the lecturer who started the
  // session. `toSession` deliberately ignores it: the lecturer-facing response
  // shape is unchanged by this column being selected.
  started_by_lecturer_id: string;
  course_code: string;
  course_title: string;
  start_time: Date;
  end_time: Date;
  late_threshold_minutes: number;
  status: "ACTIVE" | "ENDED";
  current_state: "ACTIVE" | "EXPIRED" | "ENDED";
  ended_at: Date | null;
}

const SESSION_SELECT = `
  SELECT s.id, s.course_offering_id, s.started_by_lecturer_id,
         o.sync_id AS course_offering_sync_id,
         c.course_code, c.title AS course_title,
         s.start_time, s.end_time,
         (EXTRACT(EPOCH FROM s.late_threshold) / 60)::int AS late_threshold_minutes,
         s.status, s.ended_at,
         CASE
           WHEN s.status = 'ENDED' THEN 'ENDED'
           WHEN now() <= s.end_time THEN 'ACTIVE'
           ELSE 'EXPIRED'
         END AS current_state
  FROM attendance_sessions s
  JOIN course_offerings o ON o.id = s.course_offering_id
  JOIN courses c ON c.id = o.course_id
`;

const UNIQUE_VIOLATION_CODE = "23505";

/**
 * The lecturer's display name and staff id, for the synchronized session payload.
 *
 * Read on the caller's own client so it is part of the same transaction as the
 * event. Fetched here rather than added to `SESSION_SELECT` deliberately: it is
 * needed only by the feed, and widening the session's domain shape (and every
 * caller of it) to carry a field nothing else reads would be a larger change
 * than the feature needs.
 */
async function lecturerDisplay(
  client: PoolClient,
  lecturerId: number
): Promise<{ name: string; staffId: string }> {
  const result = await client.query(
    `SELECT lec.staff_id, u.name
     FROM lecturers lec
     JOIN users u ON u.id = lec.user_id
     WHERE lec.id = $1`,
    [lecturerId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Lecturer ${lecturerId} has no profile row, so its attendance session cannot be synchronized.`
    );
  }
  return { name: row.name as string, staffId: row.staff_id as string };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

function toSession(row: SessionRow): AttendanceSession {
  return {
    id: Number(row.id),
    courseOfferingId: Number(row.course_offering_id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    lateThresholdMinutes: row.late_threshold_minutes,
    status: row.status,
    currentState: row.current_state,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
  };
}

async function findLecturerProfileId(userId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM lecturers WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

export async function listLecturerSessions(
  userId: number
): Promise<ListSessionsResult> {
  const lecturerId = await findLecturerProfileId(userId);
  if (lecturerId === null) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }

  const result = await pool.query(
    `${SESSION_SELECT}
     WHERE s.started_by_lecturer_id = $1
     ORDER BY s.start_time DESC, s.id DESC`,
    [lecturerId]
  );
  return { ok: true, data: result.rows.map(toSession) };
}

export async function createAttendanceSession(
  userId: number,
  input: CreateAttendanceSessionInput
): Promise<CreateSessionResult> {
  const lecturerId = await findLecturerProfileId(userId);
  if (lecturerId === null) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize concurrent session-lifecycle operations for this lecturer so the
    // reconciliation below can never race with another creation or manual end.
    await client.query(`SELECT id FROM lecturers WHERE id = $1 FOR UPDATE`, [
      lecturerId,
    ]);

    const offeringResult = await client.query(
      `SELECT o.id, o.status AS offering_status, c.status AS course_status
       FROM course_offerings o
       JOIN courses c ON c.id = o.course_id
       WHERE o.id = $1`,
      [input.courseOfferingId]
    );
    const offeringRow = offeringResult.rows[0];
    if (!offeringRow) {
      await client.query("ROLLBACK");
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (offeringRow.offering_status !== "OPEN") {
      await client.query("ROLLBACK");
      return { ok: false, code: "OFFERING_NOT_OPEN" };
    }
    if (offeringRow.course_status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { ok: false, code: "COURSE_NOT_ACTIVE" };
    }

    const assigned = await client.query(
      `SELECT 1 FROM course_offering_lecturers
       WHERE course_offering_id = $1 AND lecturer_id = $2`,
      [input.courseOfferingId, lecturerId]
    );
    if ((assigned.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "LECTURER_NOT_ASSIGNED" };
    }

    // The partial unique index only understands status = 'ACTIVE', so an expired
    // ACTIVE row still blocks the index. Transition it to history (ended_at = its
    // scheduled end_time) immediately before inserting the new ACTIVE session.
    await client.query(
      `UPDATE attendance_sessions
       SET status = 'ENDED', ended_at = end_time
       WHERE started_by_lecturer_id = $1 AND status = 'ACTIVE' AND end_time <= now()`,
      [lecturerId]
    );

    // Advisory, time-aware check: a session is only "currently active" while its
    // window [start_time, end_time) contains now. The unique index remains the
    // final authority and any race is translated to ACTIVE_SESSION_EXISTS below.
    const activeResult = await client.query(
      `SELECT 1 FROM attendance_sessions
       WHERE started_by_lecturer_id = $1 AND status = 'ACTIVE'
         AND start_time <= now() AND end_time > now()
       LIMIT 1`,
      [lecturerId]
    );
    if ((activeResult.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACTIVE_SESSION_EXISTS" };
    }

    const inserted = await client.query(
      `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, start_time, end_time,
        late_threshold, status)
           VALUES ($1, $2, now(), now() + ($3 * interval '1 minute'),
             ($4 * interval '1 minute'), 'ACTIVE')
       RETURNING id, sync_id`,
      [
        input.courseOfferingId,
        lecturerId,
        input.durationMinutes,
        input.lateThresholdMinutes,
      ]
    );
    const sessionId = Number(inserted.rows[0].id);
    const sessionSyncId = inserted.rows[0].sync_id as string;

    const fullRow = await client.query(`${SESSION_SELECT} WHERE s.id = $1`, [
      sessionId,
    ]);
    const sessionRow = fullRow.rows[0];
    const session = toSession(sessionRow);

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'SESSION_STARTED', 'attendance_sessions', $2, $3)`,
      [
        userId,
        sessionId,
        `Attendance session ${sessionId} started for course offering ${input.courseOfferingId}.`,
      ]
    );

    // Written on the same `client`, before the COMMIT below, so the feed can never
    // be missing a change for a session that was successfully created. If this
    // insert fails, the surrounding catch rolls the session back with it.
    const lecturer = await lecturerDisplay(client, lecturerId);

    await appendAttendanceSessionEvent(
      client,
      "attendance_session",
      sessionSyncId,
      "CREATED",
      {
        syncId: sessionSyncId,
        cloudSessionId: sessionId,
        cloudLecturerId: lecturerId,
        session: {
          courseOfferingId: session.courseOfferingId,
          courseOfferingSyncId: sessionRow.course_offering_sync_id,
          courseCode: session.courseCode,
          courseTitle: session.courseTitle,
          lecturerDisplayName: lecturer.name,
          lecturerStaffId: lecturer.staffId,
          startTime: session.startTime,
          endTime: session.endTime,
          lateThresholdMinutes: session.lateThresholdMinutes,
          status: session.status,
          endedAt: session.endedAt,
        },
      }
    );

    await client.query("COMMIT");
    return { ok: true, data: session };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      return { ok: false, code: "ACTIVE_SESSION_EXISTS" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function endSession(
  userId: number,
  sessionId: number
): Promise<EndSessionResult> {
  const lecturerId = await findLecturerProfileId(userId);
  if (lecturerId === null) {
    return { ok: false, code: "SESSION_NOT_FOUND" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ended = await client.query(
      `UPDATE attendance_sessions
       SET status = 'ENDED', ended_at = now()
       WHERE id = $1 AND started_by_lecturer_id = $2
         AND status = 'ACTIVE' AND end_time > now()
       RETURNING id, sync_id`,
      [sessionId, lecturerId]
    );

    if ((ended.rowCount ?? 0) === 0) {
      const existing = await client.query(
        `SELECT status FROM attendance_sessions
         WHERE id = $1 AND started_by_lecturer_id = $2`,
        [sessionId, lecturerId]
      );
      const row = existing.rows[0];
      await client.query("ROLLBACK");
      if (!row) {
        return { ok: false, code: "SESSION_NOT_FOUND" };
      }
      if (row.status === "ENDED") {
        return { ok: false, code: "SESSION_ALREADY_ENDED" };
      }
      return { ok: false, code: "SESSION_EXPIRED" };
    }

    const endedId = Number(ended.rows[0].id);
    const endedSyncId = ended.rows[0].sync_id as string;
    const fullRow = await client.query(`${SESSION_SELECT} WHERE s.id = $1`, [
      endedId,
    ]);
    const sessionRow = fullRow.rows[0];
    const session = toSession(sessionRow);

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'SESSION_ENDED', 'attendance_sessions', $2, $3)`,
      [
        userId,
        endedId,
        `Attendance session ${endedId} ended manually by lecturer.`,
      ]
    );

    const endedLecturer = await lecturerDisplay(client, lecturerId);

    // Same-transaction closure event. It carries the full post-close session, so
    // the edge overwrites its local copy rather than having to know what the row
    // looked like when it was ACTIVE.
    await appendAttendanceSessionEvent(
      client,
      "attendance_session",
      endedSyncId,
      "CLOSED",
      {
        syncId: endedSyncId,
        cloudSessionId: endedId,
        cloudLecturerId: lecturerId,
session: {
          courseOfferingId: session.courseOfferingId,
          courseOfferingSyncId: sessionRow.course_offering_sync_id,
          courseCode: session.courseCode,
          courseTitle: session.courseTitle,
          lecturerDisplayName: endedLecturer.name,
          lecturerStaffId: endedLecturer.staffId,
          startTime: session.startTime,
          endTime: session.endTime,
          lateThresholdMinutes: session.lateThresholdMinutes,
          status: session.status,
          endedAt: session.endedAt,
        },
      }
    );

    await client.query("COMMIT");
    return { ok: true, data: session };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Admin: read-only session list / detail with joined information
// ---------------------------------------------------------------------------

interface AdminSessionRow {
  id: string;
  course_offering_id: string;
  course_code: string;
  course_title: string;
  lecturer_id: string;
  lecturer_staff_id: string;
  lecturer_name: string;
  academic_session_id: string;
  academic_session_name: string;
  semester_id: string;
  semester_name: string;
  start_time: Date;
  end_time: Date;
  late_threshold_minutes: number;
  status: "ACTIVE" | "ENDED";
  current_state: "ACTIVE" | "EXPIRED" | "ENDED";
  ended_at: Date | null;
  created_at: Date;
}

const ADMIN_SESSION_SELECT = `
  SELECT s.id, s.course_offering_id,
         c.course_code, c.title AS course_title,
         lec.id AS lecturer_id, lec.staff_id AS lecturer_staff_id,
         lec_u.name AS lecturer_name,
         acad.id AS academic_session_id, acad.name AS academic_session_name,
         sem.id AS semester_id, sem.name AS semester_name,
         s.start_time, s.end_time,
         (EXTRACT(EPOCH FROM s.late_threshold) / 60)::int AS late_threshold_minutes,
         s.status, s.ended_at, s.created_at,
         CASE
           WHEN s.status = 'ENDED' THEN 'ENDED'
           WHEN now() <= s.end_time THEN 'ACTIVE'
           ELSE 'EXPIRED'
         END AS current_state
  FROM attendance_sessions s
  JOIN course_offerings o ON o.id = s.course_offering_id
  JOIN courses c ON c.id = o.course_id
  JOIN lecturers lec ON lec.id = s.started_by_lecturer_id
  JOIN users lec_u ON lec_u.id = lec.user_id
  JOIN academic_sessions acad ON acad.id = o.academic_session_id
  JOIN semesters sem ON sem.id = o.semester_id
`;

function toAdminSession(row: AdminSessionRow): AdminAttendanceSession {
  return {
    id: Number(row.id),
    courseOfferingId: Number(row.course_offering_id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    lecturerId: Number(row.lecturer_id),
    lecturerStaffId: row.lecturer_staff_id,
    lecturerName: row.lecturer_name,
    academicSessionId: Number(row.academic_session_id),
    academicSessionName: row.academic_session_name,
    semesterId: Number(row.semester_id),
    semesterName: row.semester_name,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    lateThresholdMinutes: row.late_threshold_minutes,
    status: row.status,
    currentState: row.current_state,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listAdminSessions(
  filters: AdminAttendanceSessionFilters
): Promise<AdminAttendanceSession[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.courseOfferingId !== undefined) {
    conditions.push(`s.course_offering_id = $${idx}`);
    params.push(filters.courseOfferingId);
    idx++;
  }
  if (filters.lecturerId !== undefined) {
    conditions.push(`s.started_by_lecturer_id = $${idx}`);
    params.push(filters.lecturerId);
    idx++;
  }
  if (filters.academicSessionId !== undefined) {
    conditions.push(`o.academic_session_id = $${idx}`);
    params.push(filters.academicSessionId);
    idx++;
  }
  if (filters.semesterId !== undefined) {
    conditions.push(`o.semester_id = $${idx}`);
    params.push(filters.semesterId);
    idx++;
  }
  if (filters.status !== undefined) {
    conditions.push(`s.status = $${idx}`);
    params.push(filters.status);
    idx++;
  }
  if (filters.from !== undefined) {
    conditions.push(`s.start_time >= $${idx}`);
    params.push(filters.from);
    idx++;
  }
  if (filters.to !== undefined) {
    conditions.push(`s.start_time <= $${idx}`);
    params.push(filters.to);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `${ADMIN_SESSION_SELECT} ${where} ORDER BY s.start_time DESC, s.id DESC`;

  const result = await pool.query(query, params);
  return result.rows.map(toAdminSession);
}

export async function getAdminSessionById(
  id: number
): Promise<AdminAttendanceSession | null> {
  const result = await pool.query(`${ADMIN_SESSION_SELECT} WHERE s.id = $1`, [
    id,
  ]);
  if (result.rows.length === 0) {
    return null;
  }
  return toAdminSession(result.rows[0]);
}

export async function listAdminAttendanceRecords(
  sessionId: number
): Promise<AdminAttendanceRecord[]> {
  const result = await pool.query(
    `SELECT ar.id, ar.status, ar.marked_at,
            st.id AS student_id, st.matric_number,
            su.name AS student_name,
            c.course_code, c.title AS course_title,
            s.id AS session_id, s.start_time AS session_start_time,
            s.end_time AS session_end_time
     FROM attendance_records ar
     JOIN students st ON st.id = ar.student_id
     JOIN users su ON su.id = st.user_id
     JOIN attendance_sessions s ON s.id = ar.session_id
     JOIN course_offerings o ON o.id = s.course_offering_id
     JOIN courses c ON c.id = o.course_id
     WHERE ar.session_id = $1
     ORDER BY su.name, st.matric_number`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    studentId: Number(row.student_id),
    matricNumber: row.matric_number,
    studentName: row.student_name,
    courseCode: row.course_code,
    courseTitle: row.course_title,
    sessionId: Number(row.session_id),
    sessionStartTime: row.session_start_time.toISOString(),
    sessionEndTime: row.session_end_time.toISOString(),
    previousStatus: row.status,
    status: row.status as AttendanceRecordStatus,
    markedAt: row.marked_at.toISOString(),
  }));
}