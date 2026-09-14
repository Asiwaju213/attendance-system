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
