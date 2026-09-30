import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

export function StaffLoginPage() {
  return (
    <AuthShell
      title="Staff Login"
      eyebrow="Staff Access"
      description="Lecturer and administrator sign-in for the OOU Attendance System."
      subtitle="Choose how you would like to sign in."
    >
      <nav className="staff-choice" aria-label="Staff login options">
        <Link className="staff-choice__link" to="/staff/lecturer/login">
          <span className="staff-choice__title">Lecturer Login</span>
          <span className="staff-choice__hint">Sign in with your staff ID.</span>
        </Link>
        <Link className="staff-choice__link" to="/staff/admin/login">
          <span className="staff-choice__title">Admin Login</span>
          <span className="staff-choice__hint">Sign in with your admin username.</span>
        </Link>
      </nav>
    </AuthShell>
  );
}