import { pool } from "../db/pool";
import {
  AdminAttendanceRecord,
  AttendanceRecordStatus,
} from "../types/attendanceSession";

export type CorrectAttendanceRecordErrorCode =
  | "RECORD_NOT_FOUND"
  | "NO_OP_CORRECTION";

export type CorrectAttendanceRecordResult =
  | { ok: true; data: AdminAttendanceRecord }
  | { ok: false; code: CorrectAttendanceRecordErrorCode };

interface CorrectionRow {
  id: string;
  status: AttendanceRecordStatus;
  marked_at: Date;
  student_id: string;
  matric_number: string;
  student_name: string;
  course_code: string;
  course_title: string;
  session_id: string;
  session_start_time: Date;
  session_end_time: Date;
}

export async function correctAttendanceRecord(
  adminUserId: number,
  recordId: number,
  newStatus: AttendanceRecordStatus
): Promise<CorrectAttendanceRecordResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const recordResult = await client.query(
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
       WHERE ar.id = $1
       FOR UPDATE OF ar`,
      [recordId]
    );
    const row = recordResult.rows[0] as CorrectionRow | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, code: "RECORD_NOT_FOUND" };
    }

    const previousStatus = row.status;
    if (previousStatus === newStatus) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NO_OP_CORRECTION" };
    }

    await client.query(
      `UPDATE attendance_records SET status = $1 WHERE id = $2`,
      [newStatus, recordId]
    );

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description)
       VALUES ($1, 'ATTENDANCE_RECORD_CORRECTED', 'attendance_records', $2, $3)`,
      [
        adminUserId,
        recordId,
        `Admin corrected attendance record ${recordId} for student ${row.student_name} (${row.matric_number}) on course ${row.course_code} (${row.course_title}) (session ${row.session_id}): status changed from ${previousStatus} to ${newStatus}.`,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      data: {
        id: Number(row.id),
        studentId: Number(row.student_id),
        matricNumber: row.matric_number,
        studentName: row.student_name,
        courseCode: row.course_code,
        courseTitle: row.course_title,
        sessionId: Number(row.session_id),
        sessionStartTime: row.session_start_time.toISOString(),
        sessionEndTime: row.session_end_time.toISOString(),
        previousStatus,
        status: newStatus,
        markedAt: row.marked_at.toISOString(),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}