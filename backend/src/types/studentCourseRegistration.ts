import { CourseScope } from "./course";

export interface RegistrationAcademicSession {
  id: number;
  name: string;
}

export interface RegistrationDepartment {
  id: number;
  name: string;
  code: string;
}

export interface RegistrationFaculty {
  id: number;
  name: string;
  code: string;
}

export interface RegistrationSemester {
  id: number;
  name: string;
}

export interface RegistrationLecturer {
  id: number;
  name: string;
}

export interface StudentOfferingCourse {
  offeringId: number;
  courseId: number;
  courseCode: string;
  title: string;
  level: number;
  scope: CourseScope;
  department: RegistrationDepartment | null;
  faculty: RegistrationFaculty | null;
  semester: RegistrationSemester;
  lecturers: RegistrationLecturer[];
  isRegistered: boolean;
}

export interface EligibleCoursesPayload {
  academicSession: RegistrationAcademicSession | null;
  courses: StudentOfferingCourse[];
}

export interface RegisteredCourseRef {
  offeringId: number;
  courseCode: string;
  title: string;
}

export interface RegistrationResultPayload {
  registered: RegisteredCourseRef[];
  alreadyRegistered: RegisteredCourseRef[];
}