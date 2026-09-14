import { OrganizationStatus } from "./organization";

export interface AttendanceLocation {
  id: number;
  name: string;
  description: string | null;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveLocationForLecturer {
  id: number;
  name: string;
  description: string | null;
}