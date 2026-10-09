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

export function LecturerHomePage() {
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
    navigate("/staff/lecturer/login", { replace: true });
  }

  return (
    <main className="lecturer-home">
      <header className="lecturer-home-header">
        <div className="lecturer-home-header__copy">
          <p className="lecturer-home-header__eyebrow">Lecturer portal</p>
          <h1>Lecturer Home</h1>
          <p className="lecturer-home-greeting">
            {greetingForLocalTime()}, {user.name}
          </p>
        </div>
        <div className="lecturer-home-header__account">
          <span className="lecturer-home-header__role">Signed in as Lecturer</span>
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

      <section className="lecturer-identity" aria-labelledby="lecturer-identity-heading">
        <h2 id="lecturer-identity-heading" className="visually-hidden">
          Lecturer details
        </h2>
        <p className="lecturer-detail">
          <span className="lecturer-detail__label">Role: </span>
          {statusLabel(user.role)}
        </p>
        <p className="lecturer-detail">
          <span className="lecturer-detail__label">Staff ID: </span>
          {user.staffId ?? "Not available"}
        </p>
      </section>

      <section className="lecturer-actions" aria-labelledby="lecturer-actions-heading">
        <h2 id="lecturer-actions-heading" className="visually-hidden">
          Teaching tasks
        </h2>

        <div className="lecturer-action-grid">
          <Link
            className="lecturer-action-card lecturer-action-card--primary"
            to="/app/lecturer/attendance"
          >
            <span className="lecturer-action-icon" aria-hidden="true">
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
            <span className="lecturer-action-copy">
              <span className="lecturer-action-label">Manage attendance sessions</span>
              <span className="lecturer-action-description">
                Start, monitor, and end attendance sessions.
              </span>
            </span>
          </Link>

          <Link
            className="lecturer-action-card lecturer-action-card--secondary"
            to="/app/lecturer/attendance-reports"
          >
            <span className="lecturer-action-icon" aria-hidden="true">
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
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </span>
            <span className="lecturer-action-copy">
              <span className="lecturer-action-label">View attendance reports</span>
              <span className="lecturer-action-description">
                Attendance totals and session records for your courses.
              </span>
            </span>
          </Link>
        </div>
      </section>
    </main>
  );
}