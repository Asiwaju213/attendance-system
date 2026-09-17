export const SESSION_STATUSES = ["ACTIVE", "ENDED"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_CURRENT_STATES = ["ACTIVE", "EXPIRED", "ENDED"] as const;

export type SessionCurrentState = (typeof SESSION_CURRENT_STATES)[number];

export interface AttendanceSession {
  id: number;
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  attendanceNetworkId: number;
  attendanceNetworkName: string;
  locationId: number;
  locationName: string;
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
  attendanceNetworkCode: string;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  createdAt: string;
}

export const ATTENDANCE_STATES = ["NOT_MARKED", "PRESENT", "LATE"] as const;

export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export interface EligibleAttendanceSession {
  id: number;
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
  attendanceNetworkName: string;
  locationName: string;
  currentAttendanceState: AttendanceState;
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
  attendanceSessionId: number;
  studentId: number;
  status: AttendanceRecordStatus;
  markedAt: string;
  courseCode: string;
  courseTitle: string;
}