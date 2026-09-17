import { pool } from "../db/pool";
import {
  CourseOfferingAttendanceReport,
  CourseOfferingReportContext,
  CourseOfferingReportLecturer,
  CourseOfferingStudentAttendance,
} from "../types/attendanceReport";

interface OfferingContextRow {
  offering_id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  academic_session_id: string;
  academic_session_name: string;
  semester_id: string;
  semester_name: string;
  level_id: string;
  level_name: string;
  total_completed_sessions: string;
}

interface LecturerRow {
  lecturer_id: string;
  user_id: string;
  staff_id: string;
  lecturer_name: string;
}

interface StudentAttendanceRow {
  student_id: string;
  user_id: string;
  matric_number: string;
  student_name: string;
  total_completed: string;
  present_count: string;
  late_count: string;
  absent_count: string;
  attendance_percentage: string | null;
}

function toContext(row: OfferingContextRow): Omit<CourseOfferingReportContext, "lecturers"> {
  return {
    id: Number(row.offering_id),
    courseId: Number(row.course_id),
    courseCode: row.course_code,
    courseTitle: row.course_title,
    academicSessionId: Number(row.academic_session_id),
    academicSessionName: row.academic_session_name,
    semesterId: Number(row.semester_id),
    semesterName: row.semester_name,
    levelId: Number(row.level_id),
    levelName: Number(row.level_name),
    totalCompletedSessions: Number(row.total_completed_sessions),
  };
}

function toLecturer(row: LecturerRow): CourseOfferingReportLecturer {
  return {
    id: Number(row.lecturer_id),
    userId: Number(row.user_id),
    staffId: row.staff_id,
    name: row.lecturer_name,
  };
}

function toStudent(row: StudentAttendanceRow): CourseOfferingStudentAttendance {
  const totalCompletedSessions = Number(row.total_completed);
  const presentCount = Number(row.present_count);
  const lateCount = Number(row.late_count);
  return {
    studentId: Number(row.student_id),
    userId: Number(row.user_id),
    matricNumber: row.matric_number,
    studentName: row.student_name,
    totalCompletedSessions,
    presentCount,
    lateCount,
    absentCount: Number(row.absent_count),
    attendancePercentage:
      totalCompletedSessions === 0 ? null : Number(row.attendance_percentage),
  };
}

/**
 * Attendance report for one course offering.
 *
 * Only sessions with status = 'ENDED' count as completed. Students are the ones
 * currently ENROLLED for the offering. For each completed session an enrolled
 * student with no attendance record is ABSENT. PRESENT and LATE both count as
 * attendance; the percentage is based on completed sessions. All aggregation is
 * performed by PostgreSQL (no N+1, no client-side tallying).
 */
export async function getCourseOfferingAttendanceReport(
  courseOfferingId: number
): Promise<CourseOfferingAttendanceReport | null> {
  const contextResult = await pool.query(
    `SELECT o.id AS offering_id,
            c.id AS course_id, c.course_code, c.title AS course_title,
            a.id AS academic_session_id, a.name AS academic_session_name,
            sem.id AS semester_id, sem.name AS semester_name,
            lv.id AS level_id, lv.name AS level_name,
            (SELECT COUNT(*) FROM attendance_sessions s
             WHERE s.course_offering_id = o.id AND s.status = 'ENDED') AS total_completed_sessions
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id
     JOIN academic_sessions a ON a.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     JOIN levels lv ON lv.id = c.level_id
     WHERE o.id = $1`,
    [courseOfferingId]
  );
  const contextRow = contextResult.rows[0] as OfferingContextRow | undefined;
  if (!contextRow) {
    return null;
  }

  const lecturersResult = await pool.query(
    `SELECT l.id AS lecturer_id, l.user_id, l.staff_id, u.name AS lecturer_name
     FROM course_offering_lecturers col
     JOIN lecturers l ON l.id = col.lecturer_id
     JOIN users u ON u.id = l.user_id
     WHERE col.course_offering_id = $1
     ORDER BY col.assigned_at ASC, col.id ASC`,
    [courseOfferingId]
  );

  const studentsResult = await pool.query(
    `WITH completed AS (
       SELECT id
       FROM attendance_sessions
       WHERE course_offering_id = $1 AND status = 'ENDED'
     ), totals AS (
       SELECT COUNT(*) AS total FROM completed
     )
     SELECT st.id AS student_id,
            u.id AS user_id,
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
     GROUP BY st.id, u.id, st.matric_number, u.name, t.total
     ORDER BY u.name ASC, st.matric_number ASC`,
    [courseOfferingId]
  );

  return {
    courseOffering: {
      ...toContext(contextRow),
      lecturers: lecturersResult.rows.map((row) => toLecturer(row as LecturerRow)),
    },
    students: studentsResult.rows.map((row) => toStudent(row as StudentAttendanceRow)),
  };
}