import { OrganizationStatus } from "../types/organization";

const MAX_COURSE_CODE_LENGTH = 32;
const MAX_TITLE_LENGTH = 200;

export interface CourseCreateInput {
  courseCode: string;
  title: string;
  levelId: number;
  facultyId?: number;
  departmentId?: number;
}

export interface CourseUpdateInput {
  courseCode?: string;
  title?: string;
  levelId?: number;
  facultyId?: number;
  departmentId?: number;
  status?: OrganizationStatus;
}

export interface CourseListFilters {
  facultyId?: number;
  departmentId?: number;
  levelId?: number;
  status?: OrganizationStatus;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseStringField(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
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

export function parseCreateCourse(body: unknown): CourseCreateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const courseCode = parseStringField(obj.courseCode, MAX_COURSE_CODE_LENGTH);
  const title = parseStringField(obj.title, MAX_TITLE_LENGTH);
  const levelId = parseBodyId(obj.levelId);
  if (!courseCode || !title || !levelId) {
    return null;
  }

  const hasFaculty = Object.prototype.hasOwnProperty.call(obj, "facultyId");
  const hasDepartment = Object.prototype.hasOwnProperty.call(obj, "departmentId");
  if (hasFaculty === hasDepartment) {
    return null;
  }

  if (hasFaculty) {
    const facultyId = parseBodyId(obj.facultyId);
    if (!facultyId) {
      return null;
    }
    return { courseCode: courseCode.toUpperCase(), title, levelId, facultyId };
  }

  const departmentId = parseBodyId(obj.departmentId);
  if (!departmentId) {
    return null;
  }
  return { courseCode: courseCode.toUpperCase(), title, levelId, departmentId };
}

export function parseUpdateCourse(body: unknown): CourseUpdateInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const update: CourseUpdateInput = {};
  let hasField = false;

  if (Object.prototype.hasOwnProperty.call(obj, "courseCode")) {
    const courseCode = parseStringField(obj.courseCode, MAX_COURSE_CODE_LENGTH);
    if (!courseCode) {
      return null;
    }
    update.courseCode = courseCode.toUpperCase();
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "title")) {
    const title = parseStringField(obj.title, MAX_TITLE_LENGTH);
    if (!title) {
      return null;
    }
    update.title = title;
    hasField = true;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "levelId")) {
    const levelId = parseBodyId(obj.levelId);
    if (!levelId) {
      return null;
    }
    update.levelId = levelId;
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

  const hasFaculty = Object.prototype.hasOwnProperty.call(obj, "facultyId");
  const hasDepartment = Object.prototype.hasOwnProperty.call(obj, "departmentId");
  if (hasFaculty && hasDepartment) {
    return null;
  }
  if (hasFaculty) {
    const facultyId = parseBodyId(obj.facultyId);
    if (!facultyId) {
      return null;
    }
    update.facultyId = facultyId;
    hasField = true;
  }
  if (hasDepartment) {
    const departmentId = parseBodyId(obj.departmentId);
    if (!departmentId) {
      return null;
    }
    update.departmentId = departmentId;
    hasField = true;
  }

  if (!hasField) {
    return null;
  }
  return update;
}

export function parseCourseListFilters(query: unknown): CourseListFilters | null {
  const obj = asObject(query);
  if (!obj) {
    return null;
  }

  const filters: CourseListFilters = {};

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
  if (obj.status !== undefined) {
    const status = parseStatus(obj.status);
    if (!status) {
      return null;
    }
    filters.status = status;
  }

  return filters;
}