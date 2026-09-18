import { apiRequest } from "./client";
import type {
  EligibleAttendanceSession,
  MarkedAttendance,
  StudentAttendanceHistory,
} from "../types/attendance";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "../types/webauthn";

export function listEligibleAttendanceSessions(): Promise<{
  data: EligibleAttendanceSession[];
}> {
  return apiRequest("/student/attendance/eligible");
}

export function requestAttendanceDeviceChallenge(): Promise<{
  data: PublicKeyCredentialRequestOptionsJSON;
}> {
  return apiRequest("/student/attendance/device-challenge", { method: "POST" });
}

export function markSessionAttendance(
  attendanceSessionId: number,
  assertion: AuthenticationResponseJSON
): Promise<{ data: MarkedAttendance }> {
  return apiRequest("/student/attendance", {
    method: "POST",
    body: { attendanceSessionId, assertion },
  });
}

export function getStudentAttendanceHistory(): Promise<{
  data: StudentAttendanceHistory;
}> {
  return apiRequest("/student/attendance/history");
}
