import type { Role } from "../types/auth";

export function homePathForRole(role: Role): string {
  switch (role) {
    case "STUDENT":
      return "/app/student";
    case "LECTURER":
      return "/app/lecturer";
    case "ADMIN":
      return "/app/admin";
  }
}

export function loginPathForRole(role: Role): string {
  switch (role) {
    case "STUDENT":
      return "/login";
    case "LECTURER":
      return "/staff/lecturer/login";
    case "ADMIN":
      return "/staff/admin/login";
  }
}