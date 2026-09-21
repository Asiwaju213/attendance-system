import { Link } from "react-router-dom";
import { PlaceholderHome } from "./PlaceholderHome";

export function LecturerHomePage() {
  return (
    <PlaceholderHome heading="Lecturer Home" loginPath="/staff/lecturer/login">
      <Link to="/app/lecturer/attendance" className="auth-submit home-link">
        Manage attendance sessions
      </Link>
      <Link to="/app/lecturer/attendance-reports" className="auth-submit home-link">
        View attendance reports
      </Link>
    </PlaceholderHome>
  );
}