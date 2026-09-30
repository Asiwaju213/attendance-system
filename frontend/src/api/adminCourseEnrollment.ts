import { apiRequest } from "./client";
import type {
  AdminCourseOfferingRegistrations,
  AdminCourseOfferingRegistrationsFilters,
  AdminEnrollStudentRequest,
  AdminEnrollStudentResponse,
} from "../types/adminCourseEnrollment";

export function listCourseOfferingRegistrations(
  offeringId: number,
  filters?: AdminCourseOfferingRegistrationsFilters
): Promise<{ data: AdminCourseOfferingRegistrations }> {
  const params = new URLSearchParams();
  if (filters?.status !== undefined) params.set("status", filters.status);
  if (filters?.matricNumber) params.set("matricNumber", filters.matricNumber);
  if (filters?.studentName) params.set("studentName", filters.studentName);
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest(`/admin/course-offerings/${offeringId}/registrations${query}`);
}

export function enrollStudent(
  offeringId: number,
  input: AdminEnrollStudentRequest
): Promise<{ data: AdminEnrollStudentResponse }> {
  return apiRequest(`/admin/course-offerings/${offeringId}/registrations`, {
    method: "POST",
    body: input,
  });
}
