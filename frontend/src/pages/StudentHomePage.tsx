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

export function StudentHomePage() {
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
    navigate("/login", { replace: true });
  }

  return (
    <main className="student-home">
      <header className="student-hero">
        <h1 id="student-home-heading" className="student-heading">
          Student Home
        </h1>
        <p className="student-greeting">
          {greetingForLocalTime()}, {user.name}
        </p>
      </header>

      <section className="student-profile" aria-labelledby="student-profile-heading">
        <h2 id="student-profile-heading" className="visually-hidden">
          Student details
        </h2>
        <p className="student-detail">
          <span className="student-detail__label">Role: </span>
          {user.role}
        </p>
        <p className="student-detail">
          <span className="student-detail__label">Matric Number: </span>
          {user.matricNumber ?? "Not available"}
        </p>
      </section>

      <section
        className="student-action-section"
        aria-labelledby="student-action-heading"
      >
        <div className="student-section-heading">
          <p>Quick access</p>
          <h2 id="student-action-heading">What would you like to do?</h2>
        </div>

        <div className="student-actions">
          <Link
            className="student-action student-action--primary"
            to="/app/student/attendance"
          >
            <span className="student-action-icon" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
            <span>Mark attendance</span>
          </Link>

          <div className="student-secondary-actions">
            <Link
              className="student-action student-action--secondary student-action--featured"
              to="/app/student/registration"
            >
              <span className="student-action-icon" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </span>
              <span>Course registration</span>
            </Link>

            <Link
              className="student-action student-action--secondary"
              to="/app/student/attendance-history"
            >
              <span className="student-action-icon" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </span>
              <span>Attendance history</span>
            </Link>

            <Link
              className="student-action student-action--secondary"
              to="/app/student/device"
            >
              <span className="student-action-icon" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
              </span>
              <span>Device Enrollment</span>
            </Link>
          </div>
        </div>
      </section>

      <div className="student-logout">
        <button
          type="button"
          className="auth-submit"
          onClick={handleLogout}
          disabled={isLoggingOut}
          aria-busy={isLoggingOut}
        >
          {isLoggingOut ? "Logging out…" : "Log out"}
        </button>
      </div>
    </main>
  );
}
