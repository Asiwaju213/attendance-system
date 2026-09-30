export interface AdminOrganizationStatusRef {
  id: number;
  name: string;
  code: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface AdminFaculty {
  id: number;
  name: string;
  code: string;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  updatedAt: string;
}

export interface AdminDepartment {
  id: number;
  name: string;
  code: string;
  status: "ACTIVE" | "INACTIVE";
  facultyId: number;
  facultyName: string;
  facultyCode: string;
  createdAt: string;
  updatedAt: string;
}