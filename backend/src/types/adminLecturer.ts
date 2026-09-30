import { OrganizationStatus } from "./organization";

export interface AdminLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  departmentName: string;
  departmentCode: string;
  status: OrganizationStatus;
}