import { apiRequest } from "./client";
import type {
  EligibleCoursesPayload,
  RegistrationResultPayload,
  StudentRegistrationsPayload,
} from "../types/studentCourseRegistration";

export function getEligibleCourses(): Promise<{ data: EligibleCoursesPayload }> {
  return apiRequest("/student/registration/courses");
}

export function listMyCourseRegistrations(): Promise<{
  data: StudentRegistrationsPayload;
}> {
  return apiRequest("/student/course-registrations");
}

export function registerForCourses(
  offeringIds: number[]
): Promise<{ data: RegistrationResultPayload }> {
  return apiRequest("/student/registration/courses", {
    method: "POST",
    body: { offeringIds },
  });
}