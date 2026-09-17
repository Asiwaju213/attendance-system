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