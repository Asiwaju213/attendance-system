import { parseIdParam } from "./adminAttendanceRecordValidation";

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

export function parseStudentIdParam(value: unknown): number | null {
  return parseIdParam(value);
}

export function parseAdminDeviceListFilters(
  query: unknown
): { matricNumber?: string; studentName?: string; status?: "ACTIVE" | "REVOKED" | "NO_DEVICE" } | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const matricNumber = typeof obj.matricNumber === "string" ? obj.matricNumber.trim() : undefined;
  const studentName = typeof obj.studentName === "string" ? obj.studentName.trim() : undefined;
  const status = typeof obj.status === "string" ? obj.status : undefined;

  if (matricNumber && matricNumber.length > 100) {
    return null;
  }
  if (studentName && studentName.length > 100) {
    return null;
  }
  if (status && !["ACTIVE", "REVOKED", "NO_DEVICE"].includes(status)) {
    return null;
  }

  return {
    matricNumber,
    studentName,
    status: status as "ACTIVE" | "REVOKED" | "NO_DEVICE" | undefined,
  };
}