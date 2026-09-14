import { OrganizationStatus } from "../types/organization";

const MAX_NAME_LENGTH = 200;
const MAX_CODE_LENGTH = 32;

export interface FacultyCreateInput {
  name: string;
  code: string;
}

export interface FacultyUpdateInput {
  name?: string;
  code?: string;
  status?: OrganizationStatus;
}

export interface DepartmentCreateInput {
  name: string;
  code: string;
  facultyId: number;
}

export interface DepartmentUpdateInput {
  name?: string;
  code?: string;
  facultyId?: number;
  status?: OrganizationStatus;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object") {
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

function parseId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function parseName(body: Record<string, unknown>): string | null {
  return parseStringField(body, "name", MAX_NAME_LENGTH);
}

function parseCode(body: Record<string, unknown>): string | null {
  const code = parseStringField(body, "code", MAX_CODE_LENGTH);
  if (!code) {
    return null;
  }
  return code.toUpperCase();
}

export function parseCreateFaculty(body: unknown): FacultyCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const name = parseName(obj);
  const code = parseCode(obj);
  if (!name || !code) {
    return null;
  }
  return { name, code };
}

export function parseUpdateFaculty(body: unknown): FacultyUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: FacultyUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = parseName(obj);
    if (!name) {
      return null;
    }
    update.name = name;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "code")) {
    const code = parseCode(obj);
    if (!code) {
      return null;
    }
    update.code = code;
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

export function parseCreateDepartment(body: unknown): DepartmentCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const name = parseName(obj);
  const code = parseCode(obj);
  const facultyId = parseId(obj.facultyId);
  if (!name || !code || !facultyId) {
    return null;
  }
  return { name, code, facultyId };
}

export function parseUpdateDepartment(body: unknown): DepartmentUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: DepartmentUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = parseName(obj);
    if (!name) {
      return null;
    }
    update.name = name;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "code")) {
    const code = parseCode(obj);
    if (!code) {
      return null;
    }
    update.code = code;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "facultyId")) {
    const facultyId = parseId(obj.facultyId);
    if (!facultyId) {
      return null;
    }
    update.facultyId = facultyId;
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