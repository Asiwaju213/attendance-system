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
  createdAt: Date;
}

export interface AdminStudentListData {
  items: AdminStudentListItem[];
  total: number;
}

// Safe WebAuthn device summary for admin display. Mirrors the admin
// student-device serializer exactly: it exposes credential metadata (id, type,
// label, transports, dates) but never public-key material, raw challenges, or
// challenge hashes.
export interface AdminStudentDevice {
  id: number;
  credentialId: string;
  credType: string;
  aaguid: string | null;
  label: string | null;
  transports: string[] | null;
  status: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
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