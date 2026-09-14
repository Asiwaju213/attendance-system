import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

export function NotFoundPage() {
  return (
    <AuthShell
      title="Page Not Found"
      subtitle="The page you are looking for does not exist."
      footer={
        <>
          <Link to="/login">Go to Student Login</Link>
        </>
      }
    >
      <p>If you were signed in, your session is still active.</p>
    </AuthShell>
  );
}