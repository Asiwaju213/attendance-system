import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { useAuth } from "../app/useAuth";
import { statusLabel } from "../lib/format";

function greetingForLocalTime(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) {
    return "Good morning";
  }
  if (hour >= 12 && hour < 17) {
    return "Good afternoon";
  }
  return "Good evening";
}

export function AdminHomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  if (user === null) {
    return <LoadingPage />;
  }

  async function handleLogout() {
    if (isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate("/staff/admin/login", { replace: true });
  }

  return (
    <main className="admin-home">
      <header className="admin-home-header">
        <div className="admin-home-header__copy">
          <p className="admin-home-header__eyebrow">Administration</p>
          <h1>Admin Home</h1>
          <p className="admin-home-greeting">
            {greetingForLocalTime()}, {user.name}
          </p>
        </div>
        <div className="admin-home-header__account">
          <span>Signed in as Administrator</span>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      <section className="admin-identity" aria-labelledby="admin-identity-heading">
        <h2 id="admin-identity-heading" className="visually-hidden">
          Administrator details
        </h2>
        <p>
          <span>Name: </span>
          {user.name}
        </p>
        <p>
          <span>Role: </span>
          {statusLabel(user.role)}
        </p>
        <p>
          <span>Username: </span>
          {user.username ?? "Not available"}
        </p>
      </section>

      <div className="admin-groups">
        <section className="admin-group" aria-labelledby="admin-academic-heading">
          <header className="admin-group__header">
            <h2 id="admin-academic-heading">Academic setup</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link to="/app/admin/academic-periods">
                <span>Academic sessions and semesters</span>
                <small>Choose the active session and the semester names.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/courses">
                <span>Course management</span>
                <small>Add courses and set their level and owning department.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/course-offerings">
                <span>Course offerings</span>
                <small>Schedule courses for a session and assign lecturers.</small>
              </Link>
            </li>
          </ul>
        </section>

        <section className="admin-group" aria-labelledby="admin-students-heading">
          <header className="admin-group__header">
            <h2 id="admin-students-heading">Student management</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link to="/app/admin/students">
                <span>Student management</span>
                <small>Search accounts and change their status.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/students/import">
                <span>Student import</span>
                <small>Create accounts in bulk from a workbook.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/student-devices">
                <span>Student device administration</span>
                <small>Revoke a device that must be replaced.</small>
              </Link>
            </li>
          </ul>
        </section>

        <section className="admin-group admin-group--primary" aria-labelledby="admin-attendance-heading">
          <header className="admin-group__header">
            <h2 id="admin-attendance-heading">Attendance</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link className="admin-action-link--primary" to="/app/admin/attendance">
                <span>Attendance monitoring</span>
                <small>Open a session to review its records or correct a status.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/attendance-reports">
                <span>Attendance reports</span>
                <small>Summarise completed sessions for a course offering.</small>
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}