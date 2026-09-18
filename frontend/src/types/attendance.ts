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

export type AttendanceState = "NOT_MARKED" | "PRESENT" | "LATE";

export type AttendanceRecordStatus = "PRESENT" | "LATE";

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

export interface MarkedAttendance {
  id: number;
  attendanceSessionId: number;
  studentId: number;
  status: AttendanceRecordStatus;
  markedAt: string;
  courseCode: string;
  courseTitle: string;
}

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

export interface CorrectAttendanceRecordInput {
  status: AttendanceRecordStatus;
}

export interface CorrectAttendanceRecordResponse {
  data: AdminAttendanceRecord;
}

export interface CourseOfferingReportLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
}

export interface CourseOfferingReportContext {
  id: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  levelId: number;
  levelName: number;
  lecturers: CourseOfferingReportLecturer[];
  totalCompletedSessions: number;
}

export interface CourseOfferingStudentAttendance {
  studentId: number;
  userId: number;
  matricNumber: string;
  studentName: string;
  totalCompletedSessions: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  attendancePercentage: number | null;
}

export interface CourseOfferingAttendanceReport {
  courseOffering: CourseOfferingReportContext;
  students: CourseOfferingStudentAttendance[];
}

export type StudentHistoryAttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

export interface StudentCourseHistorySession {
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
  sessions: StudentCourseHistorySession[];
}

export interface StudentAttendanceHistory {
  courses: StudentCourseHistory[];
}