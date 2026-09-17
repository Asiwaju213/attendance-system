import { Link } from "react-router-dom";
import { PlaceholderHome } from "./PlaceholderHome";

export function StudentHomePage() {
  return (
    <PlaceholderHome heading="Student Home" loginPath="/login">
      <Link className="auth-submit home-link" to="/app/student/attendance">
        Mark attendance
      </Link>
    </PlaceholderHome>
  );
}