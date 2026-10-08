export const SESSION_STATUSES = ["ACTIVE", "ENDED"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_CURRENT_STATES = ["ACTIVE", "EXPIRED", "ENDED"] as const;

export type SessionCurrentState = (typeof SESSION_CURRENT_STATES)[number];

export interface AttendanceSession {
  id: number;
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
  status: SessionStatus;
  currentState: SessionCurrentState;
  endedAt: string | null;
}

export interface AdminAttendanceSession extends AttendanceSession {
  lecturerId: number;
  lecturerStaffId: string;
  lecturerName: string;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  createdAt: string;
}

export const ATTENDANCE_STATES = ["NOT_MARKED", "PRESENT", "LATE"] as const;

export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export interface EligibleAttendanceSession {
  /**
   * Informational id. For a LOCAL session it is the local `attendance_sessions.id`;
   * for a CLOUD session it is the cloud's `cloud_session_id`. It is NOT the address
   * of a cloud session - a cloud session is addressed by `sessionSyncId`.
   */
  id: number;
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
  currentAttendanceState: AttendanceState;
  /** Which table this session came from; the client addresses it accordingly. */
  source: "LOCAL" | "CLOUD";
  /** The session's `sync_id` UUID. Always present for CLOUD sessions, null for LOCAL ones. */
  sessionSyncId: string | null;
}

export type AttendanceRecordStatus = "PRESENT" | "LATE";

export interface AdminAttendanceRecord {
  id: number;
  studentId: number;
  matricNumber: string;
  studentName: string;
  courseCode: string;
  courseTitle: string;
  sessionId: number;
  sessionStartTime: string;
  sessionEndTime: string;
  previousStatus: AttendanceRecordStatus;
  status: AttendanceRecordStatus;
  markedAt: string;
}

export interface MarkedAttendance {
  id: number;
  /** For a LOCAL session the local session id; for a CLOUD session the cloud_session_id (informational). */
  attendanceSessionId: number;
  studentId: number;
  status: AttendanceRecordStatus;
  markedAt: string;
  courseCode: string;
  courseTitle: string;
  /** Identifies where the mark was recorded so the client can tell local from cloud. */
  source: "LOCAL" | "CLOUD";
  /** The mark's session `sync_id`. A CLOUD mark is re-addressed only by this. */
  sessionSyncId: string;
}