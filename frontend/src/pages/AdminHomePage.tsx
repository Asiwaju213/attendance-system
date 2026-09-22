import { Link } from "react-router-dom";
import { PlaceholderHome } from "./PlaceholderHome";

export function AdminHomePage() {
  return (
    <PlaceholderHome heading="Admin Home" loginPath="/staff/admin/login">
      <Link to="/app/admin/attendance" className="auth-submit home-link">
        Attendance Monitoring
      </Link>
      <Link to="/app/admin/attendance-reports" className="auth-submit home-link">
        Attendance Reports
      </Link>
      <Link to="/app/admin/academic-periods" className="auth-submit home-link">
        Academic Sessions & Semesters
      </Link>
      <Link to="/app/admin/student-devices" className="auth-submit home-link">
        Student Device Administration
      </Link>
    </PlaceholderHome>
  );
}