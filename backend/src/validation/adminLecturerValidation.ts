import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../lib/passwords";
// The department id is parsed exactly as the department administration, student and course-offering
// endpoints parse it, so a `<select>` value reaches this endpoint in the same shape it does
// everywhere else instead of being rejected over its JSON type.
import { parseIdParam } from "./adminOrgValidation";

const MAX_STAFF_ID_LENGTH = 50;
const MAX_NAME_LENGTH = 200;

const CREATE_FIELDS = ["staffId", "name", "departmentId", "temporaryPassword"] as const;

export interface CreateLecturerInput {
  staffId: string;
  name: string;
  departmentId: number;
  temporaryPassword: string;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

// A password is never trimmed: leading or trailing spaces are part of the secret.
function parsePassword(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return value;
}

/**
 * Strict lecturer-creation body.
 *
 * The field set is exact: an unknown field (passwordHash, mustChangePassword, userId, audit
 * metadata, ...) is rejected outright so a client can never dictate the stored hash or the
 * forced-change state through request data.
 *
 * Staff IDs are matched exactly at login, so they are only trimmed here and never
 * case-normalized: an id stored as typed is the id the lecturer must type.
 */
export function parseCreateLecturer(body: unknown): CreateLecturerInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const keys = Object.keys(obj).sort();
  const expected = [...CREATE_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }

  const staffId = parseTrimmedString(obj.staffId, MAX_STAFF_ID_LENGTH);
  const name = parseTrimmedString(obj.name, MAX_NAME_LENGTH);
  const temporaryPassword = parsePassword(obj.temporaryPassword);
  const departmentId = parseIdParam(obj.departmentId);
  if (!staffId || !name || !temporaryPassword || departmentId === null) {
    return null;
  }

  return { staffId, name, departmentId, temporaryPassword };
}
