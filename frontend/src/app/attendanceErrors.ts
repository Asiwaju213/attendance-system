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
  STUDENT_NOT_FOUND: "Your student profile could not be found.",
  SESSION_NOT_FOUND: "This attendance session could not be found.",
  SESSION_NOT_ACTIVE: "This attendance session is no longer active.",
  STUDENT_NOT_REGISTERED: "You are not registered for this course offering.",
  ALREADY_MARKED: "Attendance has already been marked for this session.",
  NO_ENROLLED_DEVICE:
    "No device is enrolled for your account. Enroll a device before marking attendance.",
  DEVICE_NOT_ACTIVE:
    "Your enrolled device is not active. Please re-enroll your device.",
  INVALID_CHALLENGE: "Your device challenge could not be verified. Please try again.",
  CHALLENGE_EXPIRED: "Your device challenge has expired. Please try again.",
  CHALLENGE_ALREADY_USED:
    "This device challenge has already been used. Please try again.",
  INVALID_DEVICE_ASSERTION:
    "We could not verify your device. Please try again.",
  RECORD_NOT_FOUND: "This attendance record could not be found.",
  NO_OP_CORRECTION: "The record already has that status; no correction was made.",
  INVALID_REQUEST: "The correction request was invalid. Please check and try again.",
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