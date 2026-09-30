import { AdminStudentStatus } from "../types/studentAdmin";
import { parseIdParam } from "./adminAttendanceReportValidation";

export { parseIdParam };

export interface AdminStudentListFilterInput {
  matricNumber?: string;
  name?: string;
  departmentId?: number;
  levelId?: number;
  status?: AdminStudentStatus;
}

export interface UpdateStudentStatusInput {
  status: "ACTIVE" | "INACTIVE";
}

const ALLOWED_LIST_STATUSES: readonly AdminStudentStatus[] = [
  "ACTIVE",
  "INACTIVE",
  "PENDING",
];

const ALLOWED_UPDATE_STATUSES: readonly ("ACTIVE" | "INACTIVE")[] = [
  "ACTIVE",
  "INACTIVE",
];

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Strict list filter parsing: every supplied filter must be well-formed or the
// whole request is rejected so a typo never silently broadens a query.
export function parseAdminStudentListFilters(
  query: unknown
): AdminStudentListFilterInput | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  let matricNumber: string | undefined;
  if (obj.matricNumber !== undefined) {
    if (typeof obj.matricNumber !== "string") {
      return null;
    }
    matricNumber = obj.matricNumber.trim();
    if (matricNumber.length === 0 || matricNumber.length > 100) {
      return null;
    }
  }

  let name: string | undefined;
  if (obj.name !== undefined) {
    if (typeof obj.name !== "string") {
      return null;
    }
    name = obj.name.trim();
    if (name.length === 0 || name.length > 100) {
      return null;
    }
  }

  let departmentId: number | undefined;
  if (obj.departmentId !== undefined) {
    const parsed = parseIdParam(obj.departmentId);
    if (parsed === null) {
      return null;
    }
    departmentId = parsed;
  }

  let levelId: number | undefined;
  if (obj.levelId !== undefined) {
    const parsed = parseIdParam(obj.levelId);
    if (parsed === null) {
      return null;
    }
    levelId = parsed;
  }

  let status: AdminStudentStatus | undefined;
  if (obj.status !== undefined) {
    if (typeof obj.status !== "string") {
      return null;
    }
    const normalized = obj.status.trim().toUpperCase();
    if (!ALLOWED_LIST_STATUSES.includes(normalized as AdminStudentStatus)) {
      return null;
    }
    status = normalized as AdminStudentStatus;
  }

  return { matricNumber, name, departmentId, levelId, status };
}

// Strict status-change body: exactly one field, "status", with an ACTIVE or
// INACTIVE value. PENDING is managed by the registration lifecycle and is never
// settable by an admin. Any unknown field (studentId, userId, password, audit
// metadata, ...) is rejected outright so the client can never tamper with the
// target identity or the audit trail through request data.
export function parseUpdateStudentStatus(
  body: unknown
): UpdateStudentStatusInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "status") {
    return null;
  }
  if (typeof obj.status !== "string") {
    return null;
  }
  const normalized = obj.status.trim().toUpperCase();
  if (!ALLOWED_UPDATE_STATUSES.includes(normalized as "ACTIVE" | "INACTIVE")) {
    return null;
  }
  return { status: normalized as "ACTIVE" | "INACTIVE" };
}