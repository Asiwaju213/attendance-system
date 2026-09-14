import { apiRequest } from "./client";
import type {
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