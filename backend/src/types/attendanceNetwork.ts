import { OrganizationStatus } from "./organization";

export interface AttendanceNetwork {
  id: number;
  networkCode: string;
  name: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveNetworkForLecturer {
  id: number;
  networkCode: string;
  name: string;
}