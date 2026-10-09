import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

export function NotFoundPage() {
  return (
    <AuthShell
      title="Page not found"
      eyebrow="Error 404"
      description="This address does not match any page in the OOU Attendance System."
    >
      <p className="note">
        Check the address for a typo. If you followed a link from inside the
        system, return to your dashboard and navigate from there.
      </p>
      <div className="auth-footer">
        <Link to="/login">Student sign-in</Link>
        <Link to="/staff/login">Staff sign-in</Link>
      </div>
    </AuthShell>
  );
}