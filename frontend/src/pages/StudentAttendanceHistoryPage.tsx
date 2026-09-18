import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { getStudentAttendanceHistory } from "../api/studentAttendance";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import type {
  StudentCourseHistory,
  StudentHistoryAttendanceStatus,
} from "../types/attendance";

function historyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You are not authorized to view your attendance history.";
    }
    if (error.status === 404) {
      return "Your student profile could not be found.";
    }
    if (error.status === 500) {
      return "Your attendance history could not be loaded right now. Please try again later.";
    }
  }
  return attendanceErrorMessage(error);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatTimeOnly(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPercentage(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function statusLabel(status: StudentHistoryAttendanceStatus): string {
  switch (status) {
    case "PRESENT":
      return "Present";
    case "LATE":
      return "Late";
    case "ABSENT":
      return "Absent";
  }
}

function CourseSummary({
  course,
}: {
  course: StudentCourseHistory;
}) {
  return (
    <dl className="history-summary" aria-label={`Attendance summary for ${course.courseCode}`}>
      <div className="history-summary__item">
        <dt className="history-summary__label">Completed sessions</dt>
        <dd className="history-summary__value">
          {course.summary.completedSessions}
        </dd>
      </div>
      <div className="history-summary__item">
        <dt className="history-summary__label">Present</dt>
        <dd className="history-summary__value history-summary__value--present">
          {course.summary.presentCount}
        </dd>
      </div>
      <div className="history-summary__item">
        <dt className="history-summary__label">Late</dt>
        <dd className="history-summary__value history-summary__value--late">
          {course.summary.lateCount}
        </dd>
      </div>
      <div className="history-summary__item">
        <dt className="history-summary__label">Absent</dt>
        <dd className="history-summary__value history-summary__value--absent">
          {course.summary.absentCount}
        </dd>
      </div>
      <div className="history-summary__item">
        <dt className="history-summary__label">Attendance %</dt>
        <dd className="history-summary__value">
          {formatPercentage(course.summary.attendancePercentage)}
        </dd>
      </div>
    </dl>
  );
}

export function StudentAttendanceHistoryPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [courses, setCourses] = useState<StudentCourseHistory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const inflightReloadKeyRef = useRef<number | null>(null);
  const inflightPromiseRef =
    useRef<Promise<Awaited<ReturnType<typeof getStudentAttendanceHistory>>> | null>(
      null
    );

  useEffect(() => {
    // A single in-flight request is shared across rendered views of this page
    // (including the strict-mode double effect in development), so navigating
    // to or rendering the same page never fires a second history request. The
    // Retry button bumps reloadKey, which invalidates the shared request.
    const reloadKeyChanged = inflightReloadKeyRef.current !== reloadKey;
    if (reloadKeyChanged) {
      inflightReloadKeyRef.current = reloadKey;
      inflightPromiseRef.current = getStudentAttendanceHistory();
    }

    let active = true;
    const request = inflightPromiseRef.current;
    if (request === null) {
      return;
    }

    request
      .then((result) => {
        if (!active) {
          return;
        }
        if (
          result.data === null ||
          typeof result.data !== "object" ||
          !Array.isArray(result.data.courses)
        ) {
          throw new TypeError("Unexpected attendance history response.");
        }
        setCourses(result.data.courses);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) {
          setCourses(null);
          setLoadError(historyErrorMessage(error));
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function handleLogout() {
    if (user === null || isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate("/login", { replace: true });
  }

  function handleRetry() {
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }

  if (user === null) {
    return (
      <main className="loading-page" role="status">
        Loading…
      </main>
    );
  }

  const loading = courses === null && loadError === null;

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Attendance History</h1>
          <p className="app-header__sub">
            Completed sessions and attendance for your enrolled courses.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Student navigation">
          <Link to={homePathForRole("STUDENT")}>Home</Link>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Logging out…" : "Log out"}
          </button>
        </nav>
      </header>

      {loading ? (
        <section className="app-card app-card--wide" aria-label="Attendance history">
          <p className="inline-status" role="status">
            Loading attendance history…
          </p>
        </section>
      ) : null}

      {loadError !== null ? (
        <section className="app-card app-card--wide" aria-label="Attendance history">
          <div className="resource-error">
            <FormError message={loadError} />
            <button
              type="button"
              className="secondary-button"
              onClick={handleRetry}
              aria-busy={loading}
            >
              Retry
            </button>
          </div>
        </section>
      ) : null}

      {courses !== null && courses.length === 0 ? (
        <section className="app-card app-card--wide" aria-label="Attendance history">
          <p className="inline-status" role="status">
            You have no completed attendance sessions yet.
          </p>
        </section>
      ) : null}

      {courses !== null && courses.length > 0 ? (
        <>
          {courses.map((course) => {
            const headingId = `history-course-${course.courseOfferingId}`;
            return (
              <section
                key={course.courseOfferingId}
                className="app-card app-card--wide"
                aria-labelledby={headingId}
              >
                <h2 id={headingId}>
                  {course.courseCode} — {course.courseTitle}
                </h2>

                <dl className="history-meta">
                  <div>
                    <dt>Academic session</dt>
                    <dd>{course.academicSession}</dd>
                  </div>
                  <div>
                    <dt>Semester</dt>
                    <dd>{course.semester}</dd>
                  </div>
                  <div>
                    <dt>Level</dt>
                    <dd>Level {course.level}</dd>
                  </div>
                </dl>

                <CourseSummary course={course} />

                <h3 className="history-sessions__heading">
                  Sessions ({course.summary.completedSessions})
                </h3>
                <ul className="session-list">
                  {course.sessions.map((session) => (
                    <li key={session.sessionId} className="session-list__item">
                      <div className="history-session__header">
                        <p className="session-list__title">
                          {formatDateTime(session.startTime)} –{" "}
                          {formatTimeOnly(session.endTime)}
                        </p>
                        <span
                          className={`history-status history-status--${session.status.toLowerCase()}`}
                        >
                          {statusLabel(session.status)}
                        </span>
                      </div>
                      <p className="session-list__meta">
                        Lecturer: {session.lecturerName}
                      </p>
                      <p className="session-list__meta">
                        Location: {session.locationName}
                      </p>
                      <p className="session-list__meta">
                        Attendance network: {session.attendanceNetworkName}
                      </p>
                      {session.markedAt !== null ? (
                        <p className="session-list__meta">
                          Marked at {formatDateTime(session.markedAt)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      ) : null}
    </main>
  );
}