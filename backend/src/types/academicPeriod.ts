export interface AcademicSession {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Semester {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}