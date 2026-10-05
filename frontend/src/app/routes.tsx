import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { changePasswordPath, homePathForRole, loginPathForRole } from "./navigation";
import { ProtectedRoute } from "./ProtectedRoute";
import { useAuth } from "./useAuth";
import { AdminHomePage } from "../pages/AdminHomePage";
import { AdminLoginPage } from "../pages/AdminLoginPage";
import { AdminAttendancePage } from "../pages/AdminAttendancePage";
import { AdminAttendanceReportsPage } from "../pages/AdminAttendanceReportsPage";
import { AdminAcademicPeriodsPage } from "../pages/AdminAcademicPeriodsPage";
import { AdminLecturersPage } from "../pages/AdminLecturersPage";
import { AdminStudentDevicesPage } from "../pages/AdminStudentDevicesPage";
import { AdminStudentsPage } from "../pages/AdminStudentsPage";
import { AdminStudentImportPage } from "../pages/AdminStudentImportPage";
import { AdminCourseOfferingsPage } from "../pages/AdminCourseOfferingsPage";
import { AdminCourseOfferingRosterPage } from "../pages/AdminCourseOfferingRosterPage";
import { AdminCoursesPage } from "../pages/AdminCoursesPage";
import { LecturerHomePage } from "../pages/LecturerHomePage";
import { LecturerAttendancePage } from "../pages/LecturerAttendancePage";
import { LecturerAttendanceReportsPage } from "../pages/LecturerAttendanceReportsPage";
import { LecturerSessionAttendanceReportPage } from "../pages/LecturerSessionAttendanceReportPage";
import { LecturerLoginPage } from "../pages/LecturerLoginPage";
import { LecturerChangePasswordPage } from "../pages/LecturerChangePasswordPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { StaffLoginPage } from "../pages/StaffLoginPage";
import { StudentHomePage } from "../pages/StudentHomePage";
import { StudentAttendancePage } from "../pages/StudentAttendancePage";
import { StudentAttendanceHistoryPage } from "../pages/StudentAttendanceHistoryPage";
import { StudentDevicePage, StudentEnrollDevicePage } from "../pages/StudentDevicePage";
import { StudentCourseRegistrationPage } from "../pages/StudentCourseRegistrationPage";
import { StudentLoginPage } from "../pages/StudentLoginPage";
import { StudentRegisterPage } from "../pages/StudentRegisterPage";

function RootRedirect() {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingPage />;
  }

  if (status === "unauthenticated" || user === null) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to={homePathForRole(user.role)} replace />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingPage />;
  }

  if (status === "authenticated" && user !== null) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  return children;
}

/**
 * Guard for the first-device enrollment page.
 *
 * Allows an unauthenticated visitor through: on this route that visitor is holding a
 * short-lived enrollment grant, not a session. A student who *does* already have a session has
 * nothing to enroll, so they are redirected to the normal device page instead.
 */
function AuthenticatedStudentOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingPage />;
  }

  if (status === "authenticated" && user !== null) {
    return (
      <Navigate
        to={user.role === "STUDENT" ? "/app/student/device" : homePathForRole(user.role)}
        replace
      />
    );
  }

  return children;
}

/**
 * Guard for the forced password-change page.
 *
 * The exact inverse of the `ProtectedRoute` redirect: reachable only by a signed-in lecturer
 * whose account still owes a password change. Anyone else is sent to their own home page, so
 * the page never doubles as a general password-change surface for students or admins.
 */
function LecturerPasswordChangeOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingPage />;
  }

  if (status === "unauthenticated" || user === null) {
    return <Navigate to={loginPathForRole("LECTURER")} replace />;
  }

  if (user.role !== "LECTURER" || !user.mustChangePassword) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  return children;
}

export function AppRoutes() {
  const { status } = useAuth();

  if (status === "loading") {
    return <LoadingPage label="Checking your session…" />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route
          path="/login"
          element={
            <GuestOnly>
              <StudentLoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <StudentRegisterPage />
            </GuestOnly>
          }
        />
        <Route
          path="/staff/login"
          element={
            <GuestOnly>
              <StaffLoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/staff/lecturer/login"
          element={
            <GuestOnly>
              <LecturerLoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/staff/admin/login"
          element={
            <GuestOnly>
              <AdminLoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/app/student"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentHomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/student/attendance"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentAttendancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/student/attendance-history"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentAttendanceHistoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/student/device"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentDevicePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/student/registration"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentCourseRegistrationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/student/courses"
          element={
            <ProtectedRoute role="STUDENT">
              <StudentCourseRegistrationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/lecturer"
          element={
            <ProtectedRoute role="LECTURER">
              <LecturerHomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/lecturer/attendance"
          element={
            <ProtectedRoute role="LECTURER">
              <LecturerAttendancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/lecturer/attendance-reports"
          element={
            <ProtectedRoute role="LECTURER">
              <LecturerAttendanceReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/lecturer/attendance-reports/session/:attendanceSessionId"
          element={
            <ProtectedRoute role="LECTURER">
              <LecturerSessionAttendanceReportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminHomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/attendance"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminAttendancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/attendance-reports"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminAttendanceReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/academic-periods"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminAcademicPeriodsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/student-devices"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminStudentDevicesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/lecturers"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminLecturersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/students"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminStudentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/students/import"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminStudentImportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/courses"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminCoursesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/course-offerings"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminCourseOfferingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app/admin/course-offerings/:id/roster"
          element={
            <ProtectedRoute role="ADMIN">
              <AdminCourseOfferingRosterPage />
            </ProtectedRoute>
          }
        />
        {/*
          Forced first-login password change.

          Outside `ProtectedRoute` on purpose: the account cannot reach any protected route yet,
          and the backend rejects every API call except the password change itself while the
          forced change is pending.
        */}
        <Route
          path={changePasswordPath}
          element={
            <LecturerPasswordChangeOnly>
              <LecturerChangePasswordPage />
            </LecturerPasswordChangeOnly>
          }
        />
        {/*
          First-device enrollment.

          Deliberately NOT wrapped in `ProtectedRoute`: on this route the student is holding a
          short-lived enrollment grant, not a session. The backend only issues the grant when no
          ACTIVE device exists and refuses to create a session until the ceremony commits, so
          requiring a session here would make first-device enrollment unreachable.

          If the student already has a session there is nothing to enroll, so they are sent to the
          normal device page.
        */}
        <Route
          path="/enroll-device"
          element={
            <AuthenticatedStudentOnly>
              <StudentEnrollDevicePage />
            </AuthenticatedStudentOnly>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}