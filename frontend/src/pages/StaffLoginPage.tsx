import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

export function StaffLoginPage() {
  return (
    <AuthShell
      title="Staff Login"
      eyebrow="Staff access"
      description="Sign-in for lecturers and administrators of the OOU Attendance System."
      subtitle="Choose the account type you sign in with."
    >
      <nav className="staff-choice" aria-label="Staff login options">
        <Link className="staff-choice__link" to="/staff/lecturer/login">
          <span className="staff-choice__title">Lecturer Login</span>
          <span className="staff-choice__hint">Sign in with your staff ID.</span>
        </Link>
        <Link className="staff-choice__link" to="/staff/admin/login">
          <span className="staff-choice__title">Administrator Login</span>
          <span className="staff-choice__hint">Sign in with your administrator username.</span>
        </Link>
      </nav>
    </AuthShell>
  );
}