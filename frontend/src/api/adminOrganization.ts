import { apiRequest } from "./client";
import type { AdminDepartment, AdminFaculty } from "../types/adminOrganization";

export function listAdminDepartments(): Promise<{ data: AdminDepartment[] }> {
  return apiRequest("/admin/departments");
}

export function listAdminFaculties(): Promise<{ data: AdminFaculty[] }> {
  return apiRequest("/admin/faculties");
}