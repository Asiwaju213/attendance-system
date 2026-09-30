import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { homePathForRole } from "./navigation";
import { ProtectedRoute } from "./ProtectedRoute";
import { useAuth } from "./useAuth";
import { AdminHomePage } from "../pages/AdminHomePage";
import { AdminLoginPage } from "../pages/AdminLoginPage";
import { AdminAttendancePage } from "../pages/AdminAttendancePage";
import { AdminAttendanceReportsPage } from "../pages/AdminAttendanceReportsPage";
import { AdminAcademicPeriodsPage } from "../pages/AdminAcademicPeriodsPage";
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
import { NotFoundPage } from "../pages/NotFoundPage";
import { StaffLoginPage } from "../pages/StaffLoginPage";
import { StudentHomePage } from "../pages/StudentHomePage";
import { StudentAttendancePage } from "../pages/StudentAttendancePage";
import { StudentAttendanceHistoryPage } from "../pages/StudentAttendanceHistoryPage";
import { StudentDevicePage } from "../pages/StudentDevicePage";
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
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}