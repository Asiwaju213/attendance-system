import { OrganizationStatus } from "../types/organization";

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

export interface LocationCreateInput {
  name: string;
  description: string | null;
}

export interface LocationUpdateInput {
  name?: string;
  description?: string | null;
  status?: OrganizationStatus;
}

export interface LocationListFilters {
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

function parseOptionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return "invalid";
  }
  return trimmed;
}

export function parseCreateLocation(body: unknown): LocationCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const name = parseStringField(obj.name, MAX_NAME_LENGTH);
  if (!name) {
    return null;
  }

  const descriptionResult = parseOptionalDescription(obj.description);
  if (descriptionResult === "invalid") {
    return null;
  }

  return { name, description: descriptionResult };
}

export function parseUpdateLocation(body: unknown): LocationUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: LocationUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = parseStringField(obj.name, MAX_NAME_LENGTH);
    if (!name) {
      return null;
    }
    update.name = name;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "description")) {
    const descriptionResult = parseOptionalDescription(obj.description);
    if (descriptionResult === "invalid") {
      return null;
    }
    update.description = descriptionResult;
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

export function parseLocationListFilters(
  query: unknown
): LocationListFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: LocationListFilters = {};

  if (obj.status !== undefined) {
    const status = parseStatus(obj.status);
    if (!status) {
      return null;
    }
    filters.status = status;
  }

  return filters;
}