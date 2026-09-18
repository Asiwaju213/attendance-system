export type StudentHistoryAttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

export interface CompletedSessionHistory {
  sessionId: number;
  startTime: string;
  endTime: string;
  lecturerName: string;
  locationName: string;
  attendanceNetworkName: string;
  status: StudentHistoryAttendanceStatus;
  markedAt: string | null;
}

export interface StudentCourseHistorySummary {
  completedSessions: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  attendancePercentage: number | null;
}

export interface StudentCourseHistory {
  courseOfferingId: number;
  courseCode: string;
  courseTitle: string;
  academicSession: string;
  semester: string;
  level: number;
  summary: StudentCourseHistorySummary;
  sessions: CompletedSessionHistory[];
}

export interface StudentAttendanceHistory {
  courses: StudentCourseHistory[];
}

export type StudentAttendanceHistoryResult =
  | { ok: true; data: StudentAttendanceHistory }
  | { ok: false; code: "STUDENT_NOT_FOUND" };
