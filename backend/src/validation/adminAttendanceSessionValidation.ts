import { SessionStatus } from "../types/attendanceSession";

export interface AdminAttendanceSessionFilters {
  courseOfferingId?: number;
  lecturerId?: number;
  attendanceNetworkId?: number;
  locationId?: number;
  academicSessionId?: number;
  semesterId?: number;
  status?: SessionStatus;
  from?: Date;
  to?: Date;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parsePositiveInteger(value: unknown): number | null {
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

function parseIsoTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(trimmed)
  ) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function parseIdParam(value: unknown): number | null {
  return parsePositiveInteger(value);
}

export function parseAdminAttendanceSessionListFilters(
  query: unknown
): AdminAttendanceSessionFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: AdminAttendanceSessionFilters = {};

  if (obj.courseOfferingId !== undefined) {
    const v = parsePositiveInteger(obj.courseOfferingId);
    if (v === null) return null;
    filters.courseOfferingId = v;
  }

  if (obj.lecturerId !== undefined) {
    const v = parsePositiveInteger(obj.lecturerId);
    if (v === null) return null;
    filters.lecturerId = v;
  }

  if (obj.attendanceNetworkId !== undefined) {
    const v = parsePositiveInteger(obj.attendanceNetworkId);
    if (v === null) return null;
    filters.attendanceNetworkId = v;
  }

  if (obj.locationId !== undefined) {
    const v = parsePositiveInteger(obj.locationId);
    if (v === null) return null;
    filters.locationId = v;
  }

  if (obj.academicSessionId !== undefined) {
    const v = parsePositiveInteger(obj.academicSessionId);
    if (v === null) return null;
    filters.academicSessionId = v;
  }

  if (obj.semesterId !== undefined) {
    const v = parsePositiveInteger(obj.semesterId);
    if (v === null) return null;
    filters.semesterId = v;
  }

  if (obj.status !== undefined) {
    if (typeof obj.status !== "string") return null;
    const normalized = obj.status.trim().toUpperCase();
    if (normalized !== "ACTIVE" && normalized !== "ENDED") return null;
    filters.status = normalized as SessionStatus;
  }

  if (obj.from !== undefined) {
    const v = parseIsoTimestamp(obj.from);
    if (v === null) return null;
    filters.from = v;
  }

  if (obj.to !== undefined) {
    const v = parseIsoTimestamp(obj.to);
    if (v === null) return null;
    filters.to = v;
  }

  if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
    return null;
  }

  return filters;
}
