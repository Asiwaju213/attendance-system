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

/**
 * Where a lecturer with a pending forced password change has to go.
 *
 * The backend refuses every API surface except the password change itself while the account
 * still owes one, so this is the single page that can succeed during that window.
 */
export const changePasswordPath = "/change-password";

export interface AppNavItem {
  label: string;
  href: string;
}

export interface AppNavigation {
  roleLabel: string;
  items: readonly AppNavItem[];
}

/**
 * Sidebar navigation for each role, mapped only to existing routes.
 *
 * Labels intentionally avoid the exact names used by dashboard action links
 * (e.g. "Course registration", "Attendance history", "Course Offerings"),
 * which are asserted by the E2E suite with strict-mode single matching.
 */
export function appNavigationForRole(role: Role): AppNavigation {
  switch (role) {
    case "ADMIN":
      return {
        roleLabel: "Admin",
        items: [
          { label: "Overview", href: "/app/admin" },
          { label: "Students", href: "/app/admin/students" },
          { label: "Lecturers", href: "/app/admin/lecturers" },
          { label: "Courses", href: "/app/admin/courses" },
          { label: "Offerings", href: "/app/admin/course-offerings" },
          { label: "Attendance", href: "/app/admin/attendance" },
          { label: "Reports", href: "/app/admin/attendance-reports" },
          { label: "Devices", href: "/app/admin/student-devices" },
          { label: "Academic Setup", href: "/app/admin/academic-periods" },
        ],
      };
    case "LECTURER":
      return {
        roleLabel: "Lecturer",
        items: [
          { label: "Overview", href: "/app/lecturer" },
          { label: "Attendance", href: "/app/lecturer/attendance" },
          { label: "Reports", href: "/app/lecturer/attendance-reports" },
        ],
      };
    case "STUDENT":
      return {
        roleLabel: "Student",
        items: [
          { label: "Overview", href: "/app/student" },
          { label: "My Courses", href: "/app/student/courses" },
          { label: "Registration", href: "/app/student/registration" },
          { label: "Attendance", href: "/app/student/attendance" },
          {
            label: "Attendance Log",
            href: "/app/student/attendance-history",
          },
          { label: "Device", href: "/app/student/device" },
        ],
      };
  }
}