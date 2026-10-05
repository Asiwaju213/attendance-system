import { apiRequest } from "./client";
import type {
  AdminAttendanceRecord,
  AdminAttendanceSession,
  AdminCourseOffering,
  AdminSessionFilters,
  AttendanceSession,
  CorrectAttendanceRecordInput,
  CorrectAttendanceRecordResponse,
  CourseOfferingAttendanceReport,
  LecturerAttendanceReport,
  LecturerCourseOffering,
  LecturerSessionAttendanceReport,
} from "../types/attendance";

export interface CreateAttendanceSessionInput {
  courseOfferingId: number;
  durationMinutes: number;
  lateThresholdMinutes: number;
}

export function listAttendanceSessions(): Promise<{ data: AttendanceSession[] }> {
  return apiRequest("/lecturer/attendance-sessions");
}

export function listCourseOfferings(): Promise<{ data: LecturerCourseOffering[] }> {
  return apiRequest("/lecturer/course-offerings");
}

export function createAttendanceSession(
  input: CreateAttendanceSessionInput
): Promise<{ data: AttendanceSession }> {
  return apiRequest("/lecturer/attendance-sessions", {
    method: "POST",
    body: input,
  });
}

export function endAttendanceSession(
  id: number
): Promise<{ data: AttendanceSession }> {
  return apiRequest(`/lecturer/attendance-sessions/${id}/end`, {
    method: "POST",
  });
}

export function listAdminAttendanceSessions(
  filters: AdminSessionFilters
): Promise<{ data: AdminAttendanceSession[] }> {
  const query = buildFilterQuery(filters);
  return apiRequest(`/admin/attendance-sessions${query}`);
}

export function getAdminAttendanceSession(
  id: number
): Promise<{ data: AdminAttendanceSession }> {
  return apiRequest(`/admin/attendance-sessions/${id}`);
}

export function listAdminCourseOfferings(): Promise<{
  data: AdminCourseOffering[];
}> {
  return apiRequest("/admin/course-offerings");
}

export function getCourseOfferingAttendanceReport(
  courseOfferingId: number
): Promise<{ data: CourseOfferingAttendanceReport }> {
  return apiRequest(
    `/admin/attendance-reports/course-offering/${courseOfferingId}`
  );
}

export function getLecturerCourseOfferingReport(
  courseOfferingId: number
): Promise<{ data: LecturerAttendanceReport }> {
  return apiRequest(
    `/lecturer/attendance-reports/course-offering/${courseOfferingId}`
  );
}

export function getLecturerSessionAttendanceReport(
  attendanceSessionId: number
): Promise<{ data: LecturerSessionAttendanceReport }> {
  return apiRequest(
    `/lecturer/attendance-reports/session/${attendanceSessionId}`
  );
}

function buildFilterQuery(filters: AdminSessionFilters): string {
  const params = new URLSearchParams();

  if (filters.courseOfferingId !== undefined) {
    params.set("courseOfferingId", String(filters.courseOfferingId));
  }
  if (filters.lecturerId !== undefined) {
    params.set("lecturerId", String(filters.lecturerId));
  }
  if (filters.academicSessionId !== undefined) {
    params.set("academicSessionId", String(filters.academicSessionId));
  }
  if (filters.semesterId !== undefined) {
    params.set("semesterId", String(filters.semesterId));
  }
  if (filters.status !== undefined) {
    params.set("status", filters.status);
  }
  if (filters.from !== undefined) {
    params.set("from", filters.from);
  }
  if (filters.to !== undefined) {
    params.set("to", filters.to);
  }

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function correctAttendanceRecord(
  recordId: number,
  input: CorrectAttendanceRecordInput
): Promise<CorrectAttendanceRecordResponse> {
  return apiRequest(`/admin/attendance-records/${recordId}`, {
    method: "PATCH",
    body: input,
  });
}

export function listAdminAttendanceRecords(
  sessionId: number
): Promise<{ data: AdminAttendanceRecord[] }> {
  return apiRequest(`/admin/attendance-sessions/${sessionId}/records`);
}