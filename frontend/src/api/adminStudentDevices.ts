import { apiRequest } from "./client";
import type {
  AdminStudentDeviceSummary,
  AdminDeviceListFilters,
  ResetStudentDeviceResult,
} from "../types/adminStudentDevice";

export function listAdminStudentDevices(filters?: AdminDeviceListFilters): Promise<{
  data: AdminStudentDeviceSummary[];
}> {
  const params = new URLSearchParams();
  if (filters?.matricNumber) params.set("matricNumber", filters.matricNumber);
  if (filters?.studentName) params.set("studentName", filters.studentName);
  if (filters?.status) params.set("status", filters.status);

  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest(`/admin/student-devices${query}`);
}

export function getStudentDeviceStatus(studentId: number): Promise<{
  data: AdminStudentDeviceSummary | null;
}> {
  return apiRequest(`/admin/students/${studentId}/device`);
}

export function resetStudentDevice(studentId: number): Promise<{
  data: ResetStudentDeviceResult;
}> {
  return apiRequest(`/admin/students/${studentId}/device/reset`, {
    method: "POST",
  });
}