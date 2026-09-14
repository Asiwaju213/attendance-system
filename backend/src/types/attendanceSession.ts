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