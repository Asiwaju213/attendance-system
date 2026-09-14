import { apiRequest } from "./client";
import type {
  AdminAttendanceSession,
  AdminCourseOffering,
  AdminSessionFilters,
  AttendanceLocation,
  AttendanceNetwork,
  AttendanceSession,
  LecturerCourseOffering,
} from "../types/attendance";

export interface CreateAttendanceSessionInput {
  courseOfferingId: number;
  attendanceNetworkId: number;
  locationId: number;
  durationMinutes: number;
  lateThresholdMinutes: number;
}

export function listAttendanceSessions(): Promise<{ data: AttendanceSession[] }> {
  return apiRequest("/lecturer/attendance-sessions");
}

export function listCourseOfferings(): Promise<{ data: LecturerCourseOffering[] }> {
  return apiRequest("/lecturer/course-offerings");
}

export function listAttendanceNetworks(): Promise<{ data: AttendanceNetwork[] }> {
  return apiRequest("/lecturer/attendance-networks");
}

export function listLocations(): Promise<{ data: AttendanceLocation[] }> {
  return apiRequest("/lecturer/locations");
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

export function listAdminAttendanceNetworks(): Promise<{
  data: AttendanceNetwork[];
}> {
  return apiRequest("/admin/attendance-networks");
}

export function listAdminLocations(): Promise<{ data: AttendanceLocation[] }> {
  return apiRequest("/admin/locations");
}

function buildFilterQuery(filters: AdminSessionFilters): string {
  const params = new URLSearchParams();

  if (filters.courseOfferingId !== undefined) {
    params.set("courseOfferingId", String(filters.courseOfferingId));
  }
  if (filters.lecturerId !== undefined) {
    params.set("lecturerId", String(filters.lecturerId));
  }
  if (filters.attendanceNetworkId !== undefined) {
    params.set("attendanceNetworkId", String(filters.attendanceNetworkId));
  }
  if (filters.locationId !== undefined) {
    params.set("locationId", String(filters.locationId));
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