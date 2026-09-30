export type AdminStudentStatus = "ACTIVE" | "INACTIVE" | "PENDING";

export interface AdminStudentDepartmentRef {
  id: number;
  name: string;
  code: string;
}

export interface AdminStudentLevelRef {
  id: number;
  name: number;
}

export interface AdminStudentFacultyRef {
  id: number;
  name: string;
  code: string;
}

export interface AdminStudentListItem {
  studentId: number;
  userId: number;
  name: string;
  matricNumber: string;
  department: AdminStudentDepartmentRef;
  level: AdminStudentLevelRef;
  status: AdminStudentStatus;
  registeredCourseCount: number;
  hasActiveDevice: boolean;
  createdAt: string;
}

export interface AdminStudentListData {
  items: AdminStudentListItem[];
  total: number;
}

export interface AdminStudentListFilters {
  matricNumber?: string;
  name?: string;
  departmentId?: number;
  levelId?: number;
  status?: AdminStudentStatus;
}

// Safe WebAuthn device summary for admin display. Never exposes public-key
// material, raw challenges, or challenge hashes.
export interface AdminStudentDevice {
  id: number;
  credentialId: string;
  credType: string;
  aaguid: string | null;
  label: string | null;
  transports: string[] | null;
  status: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  counter: number;
}

export interface AdminStudentDetail extends AdminStudentListItem {
  faculty: AdminStudentFacultyRef;
  device: AdminStudentDevice | null;
}

export interface AdminStudentRegistrationResetData {
  ok: true;
  studentId: number;
  userId: number;
  name: string;
  matricNumber: string;
  previousStatus: AdminStudentStatus;
  status: AdminStudentStatus;
}