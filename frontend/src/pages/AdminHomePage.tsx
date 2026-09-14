import { Link } from "react-router-dom";
import { PlaceholderHome } from "./PlaceholderHome";

export function AdminHomePage() {
  return (
    <PlaceholderHome heading="Admin Home" loginPath="/staff/admin/login">
      <Link to="/app/admin/attendance" className="auth-submit home-link">
        Attendance Monitoring
      </Link>
    </PlaceholderHome>
  );
}