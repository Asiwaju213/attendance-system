import { pool } from "../db/pool";
import {
  LecturerAttendanceReport,
  LecturerAttendanceReportResult,
  LecturerReportAttendanceStatus,
  LecturerReportSessionDetail,
  LecturerSessionAttendanceReport,
  LecturerSessionAttendanceReportResult,
} from "../types/lecturerAttendanceReport";

interface LecturerRow {
  lecturer_id: string;
  staff_id: string;
  lecturer_name: string;
}

interface OfferingContextRow {
  offering_id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  academic_session_name: string;
  semester_name: string;
  level_name: number;
  total_completed_sessions: string;
}

interface StudentAttendanceRow {
  student_id: string;
  matric_number: string;
  student_name: string;
  total_completed: string;
  present_count: string;
  late_count: string;
  absent_count: string;
  attendance_percentage: string | null;
}

interface SessionDetailRow {
  student_id: string;
  session_id: string;
  start_time: Date;
  end_time: Date;
  lecturer_name: string;
  location_name: string;
  network_name: string;
  record_status: "PRESENT" | "LATE" | null;
  marked_at: Date | null;
}

function toSessionDetail(row: SessionDetailRow): LecturerReportSessionDetail {
  return {
    sessionId: Number(row.session_id),
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    lecturerName: row.lecturer_name,
    locationName: row.location_name,
    attendanceNetworkName: row.network_name,
    status: (row.record_status ?? "ABSENT") as LecturerReportAttendanceStatus,
    markedAt: row.marked_at ? row.marked_at.toISOString() : null,
  };
}

/**
 * Lecturer-scoped attendance report for one course offering.
 *
 * Access is always derived from the authenticated user: the offering must
 * exist, be OPEN, belong to an ACTIVE course, and the lecturer must be
 * assigned to it. Any failure of those checks maps to the same
 * OFFERING_NOT_FOUND result so an assignment leak can never be probed.
 *
 * Counting rules match the admin report: only 'ENDED' sessions are completed,
 * ACTIVE/expired-but-unended sessions are excluded, absence is inferred when
 * an enrolled student has no attendance record, and no ABSENT rows are ever
 * written. Aggregation and session details are built with a bounded number of
 * parameterized queries (no N+1 fan-out); only currently ENROLLED students on
 * this offering appear, and records from other offerings never leak.
 */
export async function getLecturerCourseOfferingReport(
  userId: number,
  courseOfferingId: number
): Promise<LecturerAttendanceReportResult> {
  const profileResult = await pool.query(
    `SELECT l.id AS lecturer_id, l.staff_id, u.name AS lecturer_name
     FROM lecturers l
     JOIN users u ON u.id = l.user_id
     WHERE l.user_id = $1`,
    [userId]
  );
  const profileRow = profileResult.rows[0] as LecturerRow | undefined;
  if (!profileRow) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }
  const lecturerId = Number(profileRow.lecturer_id);

  const contextResult = await pool.query(
    `SELECT o.id AS offering_id,
            c.id AS course_id, c.course_code, c.title AS course_title,
            a.name AS academic_session_name,
            sem.name AS semester_name,
            lv.name AS level_name,
            (SELECT COUNT(*) FROM attendance_sessions s
             WHERE s.course_offering_id = o.id AND s.status = 'ENDED') AS total_completed_sessions,
            (col.id IS NOT NULL) AS is_assigned
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions a ON a.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     JOIN levels lv ON lv.id = c.level_id
     LEFT JOIN course_offering_lecturers col
       ON col.course_offering_id = o.id AND col.lecturer_id = $2
     WHERE o.id = $1
       AND o.status = 'OPEN'
       AND c.status = 'ACTIVE'`,
    [courseOfferingId, lecturerId]
  );
  const contextRow = contextResult.rows[0] as (OfferingContextRow & {
    is_assigned: boolean;
  }) | undefined;
  if (!contextRow || contextRow.is_assigned !== true) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }

  const studentsResult = await pool.query(
    `WITH completed AS (
       SELECT id
       FROM attendance_sessions
       WHERE course_offering_id = $1 AND status = 'ENDED'
     ), totals AS (
       SELECT COUNT(*) AS total FROM completed
     )
     SELECT st.id AS student_id,
            st.matric_number,
            u.name AS student_name,
            t.total AS total_completed,
            COUNT(ar.id) FILTER (WHERE ar.status = 'PRESENT') AS present_count,
            COUNT(ar.id) FILTER (WHERE ar.status = 'LATE') AS late_count,
            t.total
              - COUNT(ar.id) FILTER (WHERE ar.status = 'PRESENT')
              - COUNT(ar.id) FILTER (WHERE ar.status = 'LATE') AS absent_count,
            CASE
              WHEN t.total = 0 THEN NULL
              ELSE ROUND(
                100.0 * (
                  COUNT(ar.id) FILTER (WHERE ar.status IN ('PRESENT', 'LATE'))
                ) / t.total,
                2
              )
            END AS attendance_percentage
     FROM course_registrations cr
     CROSS JOIN totals t
     JOIN students st ON st.id = cr.student_id
     JOIN users u ON u.id = st.user_id
     LEFT JOIN attendance_records ar
       ON ar.student_id = st.id
       AND ar.session_id IN (SELECT id FROM completed)
     WHERE cr.course_offering_id = $1
       AND cr.status = 'ENROLLED'
     GROUP BY st.id, st.matric_number, u.name, t.total
     ORDER BY u.name ASC, st.matric_number ASC`,
    [courseOfferingId]
  );

  const detailsResult = await pool.query(
    `SELECT stu.id AS student_id,
            s.id AS session_id,
            s.start_time,
            s.end_time,
            lecu.name AS lecturer_name,
            loc.name AS location_name,
            net.name AS network_name,
            ar.status AS record_status,
            ar.marked_at
     FROM attendance_sessions s
     JOIN locations loc ON loc.id = s.location_id
     JOIN attendance_networks net ON net.id = s.attendance_network_id
     JOIN lecturers lec ON lec.id = s.started_by_lecturer_id
     JOIN users lecu ON lecu.id = lec.user_id
     JOIN course_registrations cr
       ON cr.course_offering_id = s.course_offering_id
      AND cr.status = 'ENROLLED'
     JOIN students stu ON stu.id = cr.student_id
     LEFT JOIN attendance_records ar
       ON ar.session_id = s.id
       AND ar.student_id = stu.id
     WHERE s.course_offering_id = $1
       AND s.status = 'ENDED'
     ORDER BY stu.id ASC, s.end_time DESC, s.id DESC`,
    [courseOfferingId]
  );

  const sessionsByStudent = new Map<number, LecturerReportSessionDetail[]>();
  for (const row of detailsResult.rows as unknown as SessionDetailRow[]) {
    const studentId = Number(row.student_id);
    let sessions = sessionsByStudent.get(studentId);
    if (!sessions) {
      sessions = [];
      sessionsByStudent.set(studentId, sessions);
    }
    sessions.push(toSessionDetail(row));
  }

  const data: LecturerAttendanceReport = {
    courseOffering: {
      courseOfferingId: Number(contextRow.offering_id),
      courseId: Number(contextRow.course_id),
      courseCode: contextRow.course_code,
      courseTitle: contextRow.course_title,
      academicSession: contextRow.academic_session_name,
      semester: contextRow.semester_name,
      level: Number(contextRow.level_name),
      lecturer: {
        id: lecturerId,
        staffId: profileRow.staff_id,
        name: profileRow.lecturer_name,
      },
      totalCompletedSessions: Number(contextRow.total_completed_sessions),
    },
    students: studentsResult.rows.map((row) => {
      const student = row as unknown as StudentAttendanceRow;
      const studentId = Number(student.student_id);
      const totalCompletedSessions = Number(student.total_completed);
      return {
        studentId,
        matricNumber: student.matric_number,
        studentName: student.student_name,
        totalCompletedSessions,
        presentCount: Number(student.present_count),
        lateCount: Number(student.late_count),
        absentCount: Number(student.absent_count),
        attendancePercentage:
          totalCompletedSessions === 0
            ? null
            : Number(student.attendance_percentage),
        sessions: sessionsByStudent.get(studentId) ?? [],
      };
    }),
  };

  return { ok: true, data };
}

/**
 * Lecturer-scoped attendance report for a single ENDED attendance session.
 *
 * Access is always derived from the authenticated user: the session must
 * exist, be ENDED, belong to an OPEN offering of an ACTIVE course, and the
 * lecturer must be assigned to that offering. Any failure of those checks —
 * including a session that exists but is not accessible to this lecturer —
 * maps to the same SESSION_NOT_FOUND result so the existence of another
 * lecturer's session can never be probed.
 *
 * ABSENT is inferred for enrolled students without an attendance record and
 * is never stored. Only currently ENROLLED students on the offering appear.
 * The report is built with a bounded number of parameterized queries
 * (no N+1 fan-out); records from other sessions never leak.
 */
export async function getLecturerSessionAttendanceReport(
  userId: number,
  attendanceSessionId: number
): Promise<LecturerSessionAttendanceReportResult> {
  const profileResult = await pool.query(
    `SELECT l.id AS lecturer_id, l.staff_id, u.name AS lecturer_name
     FROM lecturers l
     JOIN users u ON u.id = l.user_id
     WHERE l.user_id = $1`,
    [userId]
  );
  const profileRow = profileResult.rows[0] as LecturerRow | undefined;
  if (!profileRow) {
    return { ok: false, code: "LECTURER_NOT_FOUND" };
  }
  const lecturerId = Number(profileRow.lecturer_id);

  const sessionResult = await pool.query(
    `SELECT s.id AS session_id,
            s.course_offering_id,
            s.start_time,
            s.end_time,
            (EXTRACT(EPOCH FROM s.late_threshold) / 60)::int AS late_threshold_minutes,
            s.ended_at,
            s.started_by_lecturer_id,
            c.id AS course_id,
            c.course_code,
            c.title AS course_title,
            a.name AS academic_session_name,
            sem.name AS semester_name,
            lv.name AS level_name,
            net.name AS network_name,
            loc.name AS location_name,
            lecu.name AS started_by_lecturer_name,
            lec.staff_id AS started_by_staff_id,
            (col.id IS NOT NULL) AS is_assigned
     FROM attendance_sessions s
     JOIN course_offerings o ON o.id = s.course_offering_id
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions a ON a.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     JOIN levels lv ON lv.id = c.level_id
     JOIN attendance_networks net ON net.id = s.attendance_network_id
     JOIN locations loc ON loc.id = s.location_id
     JOIN lecturers lec ON lec.id = s.started_by_lecturer_id
     JOIN users lecu ON lecu.id = lec.user_id
     LEFT JOIN course_offering_lecturers col
       ON col.course_offering_id = s.course_offering_id
      AND col.lecturer_id = $2
     WHERE s.id = $1
       AND s.status = 'ENDED'
       AND o.status = 'OPEN'
       AND c.status = 'ACTIVE'`,
    [attendanceSessionId, lecturerId]
  );
  const sessionRow = sessionResult.rows[0] as
    | (SessionContextRow & { is_assigned: boolean })
    | undefined;
  if (!sessionRow || sessionRow.is_assigned !== true) {
    return { ok: false, code: "SESSION_NOT_FOUND" };
  }

  const studentsResult = await pool.query(
    `SELECT st.id AS student_id,
            st.matric_number,
            u.name AS student_name,
            ar.status AS record_status,
            ar.marked_at
     FROM course_registrations cr
     JOIN students st ON st.id = cr.student_id
     JOIN users u ON u.id = st.user_id
     LEFT JOIN attendance_records ar
       ON ar.session_id = $1
      AND ar.student_id = st.id
     WHERE cr.course_offering_id = $2
       AND cr.status = 'ENROLLED'
     ORDER BY u.name ASC, st.matric_number ASC`,
    [attendanceSessionId, sessionRow.course_offering_id]
  );

  const data: LecturerSessionAttendanceReport = {
    session: {
      sessionId: Number(sessionRow.session_id),
      courseCode: sessionRow.course_code,
      courseTitle: sessionRow.course_title,
      academicSession: sessionRow.academic_session_name,
      semester: sessionRow.semester_name,
      level: Number(sessionRow.level_name),
      attendanceNetworkName: sessionRow.network_name,
      locationName: sessionRow.location_name,
      startTime: sessionRow.start_time.toISOString(),
      endTime: sessionRow.end_time.toISOString(),
      lateThresholdMinutes: Number(sessionRow.late_threshold_minutes),
      endedAt: sessionRow.ended_at.toISOString(),
      startedByLecturer: {
        id: Number(sessionRow.started_by_lecturer_id),
        staffId: sessionRow.started_by_staff_id,
        name: sessionRow.started_by_lecturer_name,
      },
    },
    students: studentsResult.rows.map((row) => {
      const student = row as unknown as SessionStudentRow;
      return {
        studentId: Number(student.student_id),
        matricNumber: student.matric_number,
        studentName: student.student_name,
        status: (student.record_status ?? "ABSENT") as LecturerReportAttendanceStatus,
        markedAt: student.marked_at ? student.marked_at.toISOString() : null,
      };
    }),
  };

  return { ok: true, data };
}

interface SessionContextRow {
  session_id: string;
  course_offering_id: string;
  start_time: Date;
  end_time: Date;
  late_threshold_minutes: number;
  ended_at: Date;
  started_by_lecturer_id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  academic_session_name: string;
  semester_name: string;
  level_name: number;
  network_name: string;
  location_name: string;
  started_by_lecturer_name: string;
  started_by_staff_id: string;
}

interface SessionStudentRow {
  student_id: string;
  matric_number: string;
  student_name: string;
  record_status: "PRESENT" | "LATE" | null;
  marked_at: Date | null;
}