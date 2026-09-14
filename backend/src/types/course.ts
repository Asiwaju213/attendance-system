import { OrganizationStatus } from "./organization";

export const COURSE_SCOPES = ["FACULTY", "DEPARTMENT"] as const;

export type CourseScope = (typeof COURSE_SCOPES)[number];

export interface Course {
  id: number;
  courseCode: string;
  title: string;
  levelId: number;
  levelName: number;
  scope: CourseScope;
  facultyId: number | null;
  facultyName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}