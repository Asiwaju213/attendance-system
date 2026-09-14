const SEMESTER_NAMES = ["First Semester", "Second Semester"] as const;

const MAX_NAME_LENGTH = 200;

export interface SemesterCreateInput {
  name: string;
}

export interface SemesterUpdateInput {
  name: string;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseSemesterName(body: Record<string, unknown>): string | null {
  const value = body.name;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
    return null;
  }
  if (!(SEMESTER_NAMES as readonly string[]).includes(trimmed)) {
    return null;
  }
  return trimmed;
}

export function parseCreateSemester(body: unknown): SemesterCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const name = parseSemesterName(obj);
  if (!name) {
    return null;
  }
  return { name };
}

export function parseUpdateSemester(body: unknown): SemesterUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const name = parseSemesterName(obj);
  if (!name) {
    return null;
  }
  return { name };
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