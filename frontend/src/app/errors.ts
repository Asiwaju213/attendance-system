import { ApiError } from "../api/client";

export function errorMessageForSubmit(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Invalid credentials. Please check your details and try again.";
    }
    if (error.status === 400) {
      return "Your request could not be processed. Please check your details and try again.";
    }
  }
  return "Unable to sign in right now. Please try again later.";
}