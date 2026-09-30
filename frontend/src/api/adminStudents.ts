import { apiRequest } from "./client";
import type {
  AdminStudentDetail,
  AdminStudentListData,
  AdminStudentListFilters,
  AdminStudentListItem,
  AdminStudentRegistrationResetData,
} from "../types/studentAdmin";

export type AdminStudentStatusUpdate = "ACTIVE" | "INACTIVE";

export function listAdminStudents(
  filters?: AdminStudentListFilters
): Promise<{ data: AdminStudentListData }> {
  const params = new URLSearchParams();
  if (filters?.matricNumber) params.set("matricNumber", filters.matricNumber);
  if (filters?.name) params.set("name", filters.name);
  if (filters?.departmentId !== undefined) {
    params.set("departmentId", String(filters.departmentId));
  }
  if (filters?.levelId !== undefined) params.set("levelId", String(filters.levelId));
  if (filters?.status) params.set("status", filters.status);

  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest(`/admin/students${query}`);
}

export function getAdminStudent(
  studentId: number
): Promise<{ data: AdminStudentDetail }> {
  return apiRequest(`/admin/students/${studentId}`);
}

export function updateStudentStatus(
  studentId: number,
  status: AdminStudentStatusUpdate
): Promise<{ data: AdminStudentListItem }> {
  return apiRequest(`/admin/students/${studentId}/status`, {
    method: "PATCH",
    body: { status },
  });
}

export function resetStudentRegistration(
  studentId: number
): Promise<{ data: AdminStudentRegistrationResetData }> {
  return apiRequest(`/admin/students/${studentId}/reset-registration`, {
    method: "POST",
  });
}