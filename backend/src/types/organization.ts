export const ORGANIZATION_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export interface Faculty {
  id: number;
  name: string;
  code: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface DepartmentWithFaculty {
  id: number;
  name: string;
  code: string;
  status: OrganizationStatus;
  facultyId: number;
  facultyName: string;
  facultyCode: string;
  createdAt: Date;
  updatedAt: Date;
}