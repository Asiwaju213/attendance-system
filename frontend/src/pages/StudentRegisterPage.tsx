import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

export function StudentRegisterPage() {
  return (
    <AuthShell
      title="Student Registration"
      subtitle="Student registration is not available yet."
      footer={
        <>
          <Link to="/login">Back to Student Login</Link>
        </>
      }
    >
      <p>Registration will be available in a future release.</p>
    </AuthShell>
  );
}