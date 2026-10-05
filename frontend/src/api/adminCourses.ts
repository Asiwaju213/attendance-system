import { apiRequest } from "./client";
import type {
  AdminAssignedLecturer,
  AdminCourse,
  AdminCourseCreateInput,
  AdminCourseOfferingCreateInput,
  AdminCourseOfferingUpdateInput,
  AdminCourseUpdateInput,
} from "../types/adminCourse";
import type { AdminCourseOffering } from "../types/attendance";

export function listAdminCourses(): Promise<{ data: AdminCourse[] }> {
  return apiRequest("/admin/courses");
}

export function createAdminCourse(
  input: AdminCourseCreateInput
): Promise<{ data: AdminCourse }> {
  return apiRequest("/admin/courses", {
    method: "POST",
    body: input,
  });
}

export function updateAdminCourse(
  id: number,
  input: AdminCourseUpdateInput
): Promise<{ data: AdminCourse }> {
  return apiRequest(`/admin/courses/${id}`, {
    method: "PATCH",
    body: input,
  });
}

export function createCourseOffering(
  input: AdminCourseOfferingCreateInput
): Promise<{ data: AdminCourseOffering }> {
  return apiRequest("/admin/course-offerings", {
    method: "POST",
    body: input,
  });
}

export function updateCourseOffering(
  id: number,
  input: AdminCourseOfferingUpdateInput
): Promise<{ data: AdminCourseOffering }> {
  return apiRequest(`/admin/course-offerings/${id}`, {
    method: "PATCH",
    body: input,
  });
}

export function listOfferingLecturers(
  offeringId: number
): Promise<{ data: AdminAssignedLecturer[] }> {
  return apiRequest(`/admin/course-offerings/${offeringId}/lecturers`);
}

export function assignOfferingLecturer(
  offeringId: number,
  input: { lecturerId: number }
): Promise<{ data: AdminAssignedLecturer }> {
  return apiRequest(`/admin/course-offerings/${offeringId}/lecturers`, {
    method: "POST",
    body: input,
  });
}

export function removeOfferingLecturer(
  offeringId: number,
  lecturerId: number
): Promise<void> {
  return apiRequest(
    `/admin/course-offerings/${offeringId}/lecturers/${lecturerId}`,
    { method: "DELETE" }
  );
}