export type SessionStatus = "ACTIVE" | "ENDED";

export type SessionCurrentState = "ACTIVE" | "EXPIRED" | "ENDED";

export type OfferingStatus = "OPEN" | "CLOSED";

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

export interface AdminSessionFilters {
  courseOfferingId?: number;
  lecturerId?: number;
  attendanceNetworkId?: number;
  locationId?: number;
  academicSessionId?: number;
  semesterId?: number;
  status?: SessionStatus;
  from?: string;
  to?: string;
}

export interface AttendanceNetwork {
  id: number;
  networkCode: string;
  name: string;
}

export interface AttendanceLocation {
  id: number;
  name: string;
  description: string | null;
}

export interface LecturerCourseOffering {
  id: number;
  courseCode: string;
  courseTitle: string;
  levelName: number;
  academicSessionName: string;
  semesterName: string;
  status: OfferingStatus;
}

export interface AdminCourseOffering {
  id: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  levelId: number;
  levelName: number;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  status: OfferingStatus;
  createdAt: string;
  updatedAt: string;
}