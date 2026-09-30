import { ApiError } from "../api/client";

const ERROR_CODE_MESSAGES: Record<string, string> = {
  STUDENT_NOT_FOUND: "Your student profile could not be found.",
  NO_ACTIVE_ACADEMIC_SESSION: "Course registration is not currently open.",
  INVALID_COURSE_SELECTION:
    "One or more courses are no longer available for registration. Refresh the list and try again.",
  INVALID_REQUEST: "The registration request was invalid. Please try again.",
};

export function courseRegistrationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code !== null && ERROR_CODE_MESSAGES[error.code] !== undefined) {
      return ERROR_CODE_MESSAGES[error.code];
    }
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You are not authorized to enroll in courses.";
    }
    if (error.status === 400) {
      return "The registration request was invalid. Please try again.";
    }
  }
  return "Something went wrong. Please try again later.";
}