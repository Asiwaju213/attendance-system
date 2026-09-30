import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { useAuth } from "../app/useAuth";

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
          <p className="admin-home-greeting">{greetingForLocalTime()}</p>
          <p className="admin-home-header__description">
            Manage academic setup, students, devices, and attendance operations.
          </p>
        </div>
        <div className="admin-home-header__account">
          <span>Signed in as Admin</span>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Logging out…" : "Log out"}
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
          {user.role}
        </p>
        <p>
          <span>Username: </span>
          {user.username ?? "Not available"}
        </p>
      </section>

      <div className="admin-groups">
        <section className="admin-group" aria-labelledby="admin-academic-heading">
          <header className="admin-group__header">
            <p>Academic setup</p>
            <h2 id="admin-academic-heading">Structure your academic workspace</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link to="/app/admin/academic-periods">
                <span>Academic Sessions &amp; Semesters</span>
                <small>Manage academic periods and semesters.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/courses">
                <span>Course Management</span>
                <small>Maintain courses and their academic details.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/course-offerings">
                <span>Course Offerings</span>
                <small>Manage course offerings and teaching assignments.</small>
              </Link>
            </li>
          </ul>
        </section>

        <section className="admin-group" aria-labelledby="admin-students-heading">
          <header className="admin-group__header">
            <p>Student management</p>
            <h2 id="admin-students-heading">Support your student community</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link to="/app/admin/students">
                <span>Student Management</span>
                <small>Review and manage student records.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/students/import">
                <span>Student Import</span>
                <small>Import student records from a prepared file.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/student-devices">
                <span>Student Device Administration</span>
                <small>Review and reset student attendance devices.</small>
              </Link>
            </li>
          </ul>
        </section>

        <section className="admin-group admin-group--primary" aria-labelledby="admin-attendance-heading">
          <header className="admin-group__header">
            <p>Attendance operations</p>
            <h2 id="admin-attendance-heading">Monitor attendance activity</h2>
          </header>
          <ul className="admin-action-list">
            <li>
              <Link className="admin-action-link--primary" to="/app/admin/attendance">
                <span>Attendance Monitoring</span>
                <small>Review and manage attendance sessions.</small>
              </Link>
            </li>
            <li>
              <Link to="/app/admin/attendance-reports">
                <span>Attendance Reports</span>
                <small>Review attendance summaries and records.</small>
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
