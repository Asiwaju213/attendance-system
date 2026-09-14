import { ApiError } from "../api/client";

const ERROR_CODE_MESSAGES: Record<string, string> = {
  OFFERING_NOT_FOUND: "The selected course offering could not be found.",
  OFFERING_NOT_OPEN: "This course offering is not currently open for attendance.",
  COURSE_NOT_ACTIVE: "This course is currently inactive.",
  LECTURER_NOT_ASSIGNED: "You are not assigned to this course offering.",
  ATTENDANCE_NETWORK_NOT_FOUND:
    "The selected attendance network is no longer available.",
  ATTENDANCE_NETWORK_INACTIVE: "The selected attendance network is inactive.",
  LOCATION_NOT_FOUND: "The selected location is no longer available.",
  LOCATION_INACTIVE: "The selected location is inactive.",
  ACTIVE_SESSION_EXISTS: "You already have an active attendance session.",
  SESSION_EXPIRED: "This attendance session has already expired.",
  SESSION_ALREADY_ENDED: "This attendance session has already ended.",
};

export function attendanceErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const mapped = ERROR_CODE_MESSAGES[error.code];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  if (error instanceof ApiError && error.status === 400) {
    return "Your request could not be processed. Please check the details and try again.";
  }
  return "Something went wrong. Please try again later.";
}