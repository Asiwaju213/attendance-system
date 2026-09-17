import { pool } from "../db/pool";
import {
  EligibleAttendanceSession,
  MarkedAttendance,
} from "../types/attendanceSession";

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
  network_name: string;
  location_name: string;
  attendance_status: "PRESENT" | "LATE" | null;
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
    attendanceNetworkName: row.network_name,
    locationName: row.location_name,
    currentAttendanceState: row.attendance_status ?? "NOT_MARKED",
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

  const result = await pool.query(
    `SELECT s.id AS session_id, s.course_offering_id,
            c.course_code, c.title AS course_title,
            s.start_time, s.end_time,
            (EXTRACT(EPOCH FROM s.late_threshold) / 60)::int AS late_threshold_minutes,
            n.name AS network_name, l.name AS location_name,
            ar.status AS attendance_status
     FROM attendance_sessions s
     JOIN course_offerings o ON o.id = s.course_offering_id
     JOIN courses c ON c.id = o.course_id
     JOIN attendance_networks n ON n.id = s.attendance_network_id
     JOIN locations l ON l.id = s.location_id
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
  return { ok: true, data: result.rows.map(toEligibleSession) };
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
      `SELECT s.id, s.course_offering_id,
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