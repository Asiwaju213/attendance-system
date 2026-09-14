import { OrganizationStatus } from "../types/organization";

const MAX_NETWORK_CODE_LENGTH = 32;
const MAX_NETWORK_NAME_LENGTH = 200;

export interface AttendanceNetworkCreateInput {
  networkCode: string;
  name: string;
}

export interface AttendanceNetworkUpdateInput {
  name?: string;
  status?: OrganizationStatus;
}

export interface AttendanceNetworkListFilters {
  status?: OrganizationStatus;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseStringField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function parseStatus(value: unknown): OrganizationStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized !== "ACTIVE" && normalized !== "INACTIVE") {
    return null;
  }
  return normalized;
}

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

export function parseCreateAttendanceNetwork(
  body: unknown
): AttendanceNetworkCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const networkCode = parseStringField(obj.networkCode, MAX_NETWORK_CODE_LENGTH);
  const name = parseStringField(obj.name, MAX_NETWORK_NAME_LENGTH);
  if (!networkCode || !name) {
    return null;
  }

  return { networkCode: networkCode.toUpperCase(), name };
}

export function parseUpdateAttendanceNetwork(
  body: unknown
): AttendanceNetworkUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: AttendanceNetworkUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = parseStringField(obj.name, MAX_NETWORK_NAME_LENGTH);
    if (!name) {
      return null;
    }
    update.name = name;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "status")) {
    const status = parseStatus(obj.status);
    if (!status) {
      return null;
    }
    update.status = status;
    hasField = true;
  }

  if (!hasField) {
    return null;
  }
  return update;
}

export function parseAttendanceNetworkListFilters(
  query: unknown
): AttendanceNetworkListFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: AttendanceNetworkListFilters = {};

  if (obj.status !== undefined) {
    const status = parseStatus(obj.status);
    if (!status) {
      return null;
    }
    filters.status = status;
  }

  return filters;
}