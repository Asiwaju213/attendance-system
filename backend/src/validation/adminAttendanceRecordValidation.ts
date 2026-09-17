import { AttendanceRecordStatus } from "../types/attendanceSession";

export interface AttendanceRecordCorrectionInput {
  status: AttendanceRecordStatus;
}

const ALLOWED_STATUSES: readonly AttendanceRecordStatus[] = [
  "PRESENT",
  "LATE",
];

export function parseIdParam(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

// Strict correction body: exactly one field, "status", with a PRESENT or LATE
// value. Any unknown field (studentId, sessionId, previousStatus, adminId,
// timestamps, audit metadata, ...) is rejected outright so the client can never
// tamper with record identity or the audit trail through request data.
export function parseAttendanceRecordCorrection(
  body: unknown
): AttendanceRecordCorrectionInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "status") {
    return null;
  }
  if (typeof obj.status !== "string") {
    return null;
  }
  const normalized = obj.status.trim().toUpperCase();
  if (!ALLOWED_STATUSES.includes(normalized as AttendanceRecordStatus)) {
    return null;
  }
  return { status: normalized as AttendanceRecordStatus };
}