export type DeviceStatus = "ACTIVE" | "REVOKED" | "NO_DEVICE";

export interface AdminStudentDevice {
  id: number;
  studentId: number;
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

export interface AdminStudentDeviceSummary {
  studentId: number;
  studentName: string;
  matricNumber: string;
  device: AdminStudentDevice | null;
  hasActiveDevice: boolean;
}

export interface AdminDeviceListFilters {
  matricNumber?: string;
  studentName?: string;
  status?: DeviceStatus;
}

export interface ResetStudentDeviceResult {
  ok: true;
  device: AdminStudentDevice | null;
  previousStatus: string;
}