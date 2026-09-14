export const OFFERING_STATUSES = ["OPEN", "CLOSED"] as const;

export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export interface CourseOffering {
  id: number;
  courseId: number;
  courseCode: string;
  courseTitle: string;
  levelId: number;
  levelName: number;
  academicSessionId: number;
  academicSessionName: string;
  semesterId: number;
  semesterName: string;
  status: OfferingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignedLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  assignedAt: Date;
}

export interface OfferingForLecturer {
  id: number;
  courseCode: string;
  courseTitle: string;
  levelName: number;
  academicSessionName: string;
  semesterName: string;
  status: OfferingStatus;
}
