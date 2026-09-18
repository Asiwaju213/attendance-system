import { pool } from "../db/pool";
import {
  CompletedSessionHistory,
  StudentAttendanceHistory,
  StudentAttendanceHistoryResult,
  StudentCourseHistory,
  StudentCourseHistorySummary,
  StudentHistoryAttendanceStatus,
} from "../types/studentAttendanceHistory";

interface SessionHistoryRow {
  course_offering_id: string;
  course_code: string;
  course_title: string;
  academic_session_name: string;
  semester_name: string;
  level_name: number;
  session_id: string;
  start_time: Date;
  end_time: Date;
  lecturer_name: string | null;
  location_name: string;
  network_name: string;
  record_status: "PRESENT" | "LATE" | null;
  marked_at: Date | null;
}

function toCompletedSession(row: SessionHistoryRow): CompletedSessionHistory {
  return {
    sessionId: Number(row.session_id),
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    lecturerName: row.lecturer_name ?? "Unknown",
    locationName: row.location_name,
    attendanceNetworkName: row.network_name,
    status: (row.record_status ?? "ABSENT") as StudentHistoryAttendanceStatus,
    markedAt: row.marked_at ? row.marked_at.toISOString() : null,
  };
}

function toSummary(rows: SessionHistoryRow[]): StudentCourseHistorySummary {
  let presentCount = 0;
  let lateCount = 0;
  for (const row of rows) {
    if (row.record_status === "PRESENT") presentCount++;
    if (row.record_status === "LATE") lateCount++;
  }
  const completedSessions = rows.length;
  const attendedCount = presentCount + lateCount;
  const absentCount = completedSessions - attendedCount;
  const attendancePercentage =
    completedSessions === 0
      ? null
      : Math.round(((attendedCount / completedSessions) * 100) * 100) / 100;
  return {
    completedSessions,
    presentCount,
    lateCount,
    absentCount,
    attendancePercentage,
  };
}

async function getStudentProfileId(userId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM students WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

export async function getStudentAttendanceHistory(
  userId: number
): Promise<StudentAttendanceHistoryResult> {
  const studentProfileId = await getStudentProfileId(userId);
  if (studentProfileId === null) {
    return { ok: false, code: "STUDENT_NOT_FOUND" };
  }

  // One query returns every completed (ENDED) session for every ENROLLED,
  // active course of this student, together with the student's attendance
  // record for that session (LEFT JOIN; a missing record is ABSENT). Result is
  // grouped in JS — there is no N+1 query fan-out.
  const result = await pool.query(
    `SELECT o.id AS course_offering_id,
            c.course_code,
            c.title AS course_title,
            ac.name AS academic_session_name,
            sem.name AS semester_name,
            lv.name AS level_name,
            s.id AS session_id,
            s.start_time,
            s.end_time,
            u.name AS lecturer_name,
            loc.name AS location_name,
            net.name AS network_name,
            ar.status AS record_status,
            ar.marked_at
     FROM course_offerings o
     JOIN courses c ON c.id = o.course_id AND c.status = 'ACTIVE'
     JOIN academic_sessions ac ON ac.id = o.academic_session_id
     JOIN semesters sem ON sem.id = o.semester_id
     JOIN levels lv ON lv.id = c.level_id
     JOIN course_registrations cr
       ON cr.course_offering_id = o.id
      AND cr.student_id = $1
      AND cr.status = 'ENROLLED'
     JOIN attendance_sessions s
       ON s.course_offering_id = o.id
      AND s.status = 'ENDED'
     JOIN course_offering_lecturers col ON col.course_offering_id = o.id
     JOIN lecturers lec ON lec.id = col.lecturer_id
     JOIN users u ON u.id = lec.user_id
     JOIN locations loc ON loc.id = s.location_id
     JOIN attendance_networks net ON net.id = s.attendance_network_id
     LEFT JOIN attendance_records ar
       ON ar.session_id = s.id
      AND ar.student_id = $1
     ORDER BY o.id, s.end_time DESC`,
    [studentProfileId]
  );

  const rows = result.rows as unknown as SessionHistoryRow[];

  const byOffering = new Map<number, StudentCourseHistory>();
  for (const row of rows) {
    const offeringId = Number(row.course_offering_id);
    let course = byOffering.get(offeringId);
    if (!course) {
      course = {
        courseOfferingId: offeringId,
        courseCode: row.course_code,
        courseTitle: row.course_title,
        academicSession: row.academic_session_name,
        semester: row.semester_name,
        level: row.level_name,
        summary: {
          completedSessions: 0,
          presentCount: 0,
          lateCount: 0,
          absentCount: 0,
          attendancePercentage: null,
        },
        sessions: [],
      };
      byOffering.set(offeringId, course);
    }
    course.sessions.push(toCompletedSession(row));
  }

  for (const course of byOffering.values()) {
    course.summary = toSummary(
      course.sessions.map((s) => ({
        ...s,
        marked_at: null,
        record_status: s.status === "PRESENT" ? "PRESENT" : s.status === "LATE" ? "LATE" : null,
      })) as unknown as SessionHistoryRow[]
    );
  }

  const data: StudentAttendanceHistory = {
    courses: Array.from(byOffering.values()),
  };
  return { ok: true, data };
}
