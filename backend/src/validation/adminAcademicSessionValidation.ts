const MAX_NAME_LENGTH = 200;

export interface AcademicSessionCreateInput {
  name: string;
}

export interface AcademicSessionUpdateInput {
  name?: string;
  isActive?: boolean;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseStringField(
  body: Record<string, unknown>,
  field: string,
  maxLength: number
): string | null {
  const value = body[field];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function parseName(body: Record<string, unknown>): string | null {
  return parseStringField(body, "name", MAX_NAME_LENGTH);
}

function parseIsActive(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function parseCreateAcademicSession(
  body: unknown
): AcademicSessionCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const name = parseName(obj);
  if (!name) {
    return null;
  }
  return { name };
}

export function parseUpdateAcademicSession(
  body: unknown
): AcademicSessionUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: AcademicSessionUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = parseName(obj);
    if (!name) {
      return null;
    }
    update.name = name;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "isActive")) {
    const isActive = parseIsActive(obj.isActive);
    if (isActive === null) {
      return null;
    }
    update.isActive = isActive;
    hasField = true;
  }

  if (!hasField) {
    return null;
  }
  return update;
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