export type CourseScope = "FACULTY" | "DEPARTMENT";

export type CourseStatus = "ACTIVE" | "INACTIVE";

export type OfferingStatus = "OPEN" | "CLOSED";

export interface AdminCourse {
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
  status: CourseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCourseCreateInput {
  courseCode: string;
  title: string;
  levelId: number;
  facultyId?: number;
  departmentId?: number;
}

export interface AdminCourseUpdateInput {
  courseCode?: string;
  title?: string;
  levelId?: number;
  facultyId?: number;
  departmentId?: number;
  status?: CourseStatus;
}

export interface AdminLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  departmentName: string;
  departmentCode: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface AdminAssignedLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  assignedAt: string;
}

export interface AdminCourseOfferingCreateInput {
  courseId: number;
  academicSessionId: number;
  semesterId: number;
}

export interface AdminCourseOfferingUpdateInput {
  status?: OfferingStatus;
}