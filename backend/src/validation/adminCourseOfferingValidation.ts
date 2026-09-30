import { OfferingStatus } from "../types/courseOffering";

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseBodyId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

const REGISTRATION_STATUSES = ["ENROLLED", "DROPPED", "COMPLETED"] as const;

function parseRegistrationStatus(value: unknown): RegistrationStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!REGISTRATION_STATUSES.includes(normalized as RegistrationStatus)) {
    return null;
  }
  return normalized as RegistrationStatus;
}

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

function parseNonNegativeInt(value: unknown, max?: number): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  if (max !== undefined && parsed > max) {
    return null;
  }
  return parsed;
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

function parseStatus(value: unknown): OfferingStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized !== "OPEN" && normalized !== "CLOSED") {
    return null;
  }
  return normalized;
}

export interface OfferingCreateInput {
  courseId: number;
  academicSessionId: number;
  semesterId: number;
}

export interface OfferingUpdateInput {
  courseId?: number;
  academicSessionId?: number;
  semesterId?: number;
  status?: OfferingStatus;
}

export interface OfferingListFilters {
  courseId?: number;
  academicSessionId?: number;
  semesterId?: number;
  status?: OfferingStatus;
  facultyId?: number;
  departmentId?: number;
  levelId?: number;
}

export interface AssignLecturerInput {
  lecturerId: number;
}

export interface RegistrationListFilters {
  status?: RegistrationStatus;
  matricNumber?: string;
  studentName?: string;
  limit?: number;
  offset?: number;
}

export function parseRegistrationListFilters(query: unknown): RegistrationListFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: RegistrationListFilters = {};

  if (obj.status !== undefined) {
    const status = parseRegistrationStatus(obj.status);
    if (status === null) {
      return null;
    }
    filters.status = status;
  }

  if (obj.matricNumber !== undefined) {
    if (typeof obj.matricNumber !== "string") {
      return null;
    }
    const trimmed = obj.matricNumber.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      return null;
    }
    filters.matricNumber = trimmed;
  }

  if (obj.studentName !== undefined) {
    if (typeof obj.studentName !== "string") {
      return null;
    }
    const trimmed = obj.studentName.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      return null;
    }
    filters.studentName = trimmed;
  }

  if (obj.limit !== undefined) {
    const limit = parseNonNegativeInt(obj.limit, 500);
    if (limit === null) {
      return null;
    }
    filters.limit = limit;
  }

  if (obj.offset !== undefined) {
    const offset = parseNonNegativeInt(obj.offset);
    if (offset === null) {
      return null;
    }
    filters.offset = offset;
  }

  return filters;
}

export function parseCreateOffering(body: unknown): OfferingCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const courseId = parseBodyId(obj.courseId);
  const academicSessionId = parseBodyId(obj.academicSessionId);
  const semesterId = parseBodyId(obj.semesterId);

  if (!courseId || !academicSessionId || !semesterId) {
    return null;
  }

  return { courseId, academicSessionId, semesterId };
}

export function parseUpdateOffering(body: unknown): OfferingUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: OfferingUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "courseId")) {
    const courseId = parseBodyId(obj.courseId);
    if (!courseId) {
      return null;
    }
    update.courseId = courseId;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "academicSessionId")) {
    const academicSessionId = parseBodyId(obj.academicSessionId);
    if (!academicSessionId) {
      return null;
    }
    update.academicSessionId = academicSessionId;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "semesterId")) {
    const semesterId = parseBodyId(obj.semesterId);
    if (!semesterId) {
      return null;
    }
    update.semesterId = semesterId;
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

export function parseOfferingListFilters(query: unknown): OfferingListFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: OfferingListFilters = {};

  if (obj.courseId !== undefined) {
    const courseId = parseIdParam(obj.courseId);
    if (!courseId) {
      return null;
    }
    filters.courseId = courseId;
  }
  if (obj.academicSessionId !== undefined) {
    const academicSessionId = parseIdParam(obj.academicSessionId);
    if (!academicSessionId) {
      return null;
    }
    filters.academicSessionId = academicSessionId;
  }
  if (obj.semesterId !== undefined) {
    const semesterId = parseIdParam(obj.semesterId);
    if (!semesterId) {
      return null;
    }
    filters.semesterId = semesterId;
  }
  if (obj.status !== undefined) {
    const status = parseStatus(obj.status);
    if (!status) {
      return null;
    }
    filters.status = status;
  }
  if (obj.facultyId !== undefined) {
    const facultyId = parseIdParam(obj.facultyId);
    if (!facultyId) {
      return null;
    }
    filters.facultyId = facultyId;
  }
  if (obj.departmentId !== undefined) {
    const departmentId = parseIdParam(obj.departmentId);
    if (!departmentId) {
      return null;
    }
    filters.departmentId = departmentId;
  }
  if (obj.levelId !== undefined) {
    const levelId = parseIdParam(obj.levelId);
    if (!levelId) {
      return null;
    }
    filters.levelId = levelId;
  }

  return filters;
}

export function parseAssignLecturer(body: unknown): AssignLecturerInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const lecturerId = parseBodyId(obj.lecturerId);
  if (!lecturerId) {
    return null;
  }

  return { lecturerId };
}

export interface AdminEnrollStudentInput {
  studentId: number;
}

export function parseAdminEnrollStudent(body: unknown): AdminEnrollStudentInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "studentId") {
    return null;
  }

  const studentId = parseBodyId(obj.studentId);
  if (!studentId) {
    return null;
  }

  return { studentId };
}
