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