export type LecturerReportAttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

export interface LecturerReportSessionDetail {
  sessionId: number;
  startTime: string;
  endTime: string;
  lecturerName: string;
  locationName: string;
  attendanceNetworkName: string;
  status: LecturerReportAttendanceStatus;
  markedAt: string | null;
}

export interface LecturerReportStudentAttendance {
  studentId: number;
  matricNumber: string;
  studentName: string;
  totalCompletedSessions: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  attendancePercentage: number | null;
  sessions: LecturerReportSessionDetail[];
}

export interface LecturerCourseOfferingReportContext {
  courseOfferingId: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  academicSession: string;
  semester: string;
  level: number;
  lecturer: {
    id: number;
    staffId: string;
    name: string;
  };
  totalCompletedSessions: number;
}

export interface LecturerAttendanceReport {
  courseOffering: LecturerCourseOfferingReportContext;
  students: LecturerReportStudentAttendance[];
}

export type LecturerAttendanceReportResult =
  | { ok: true; data: LecturerAttendanceReport }
  | { ok: false; code: "LECTURER_NOT_FOUND" | "OFFERING_NOT_FOUND" };

export interface LecturerSessionReportStudent {
  studentId: number;
  matricNumber: string;
  studentName: string;
  status: LecturerReportAttendanceStatus;
  markedAt: string | null;
}

export interface LecturerSessionAttendanceReport {
  session: {
    sessionId: number;
    courseCode: string;
    courseTitle: string;
    academicSession: string;
    semester: string;
    level: number;
    attendanceNetworkName: string;
    locationName: string;
    startTime: string;
    endTime: string;
    lateThresholdMinutes: number;
    endedAt: string;
    startedByLecturer: {
      id: number;
      staffId: string;
      name: string;
    };
  };
  students: LecturerSessionReportStudent[];
}

export type LecturerSessionAttendanceReportResult =
  | { ok: true; data: LecturerSessionAttendanceReport }
  | { ok: false; code: "LECTURER_NOT_FOUND" | "SESSION_NOT_FOUND" };