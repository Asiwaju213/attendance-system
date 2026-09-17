import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import {
  getDeviceAssertion,
  isWebAuthnSupported,
  WebAuthnUnsupportedError,
} from "../lib/webauthn";
import {
  listEligibleAttendanceSessions,
  markSessionAttendance,
  requestAttendanceDeviceChallenge,
} from "../api/studentAttendance";
import type {
  AttendanceRecordStatus,
  EligibleAttendanceSession,
} from "../types/attendance";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function markErrorMessage(error: unknown): string {
  if (error instanceof WebAuthnUnsupportedError) {
    return "Device verification is not supported in this browser. Please use a browser that supports WebAuthn.";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  ) {
    return "Device verification was cancelled. Please try again when you are ready.";
  }
  return attendanceErrorMessage(error);
}

export function StudentAttendancePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<EligibleAttendanceSession[] | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [markingSessionId, setMarkingSessionId] = useState<number | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    status: AttendanceRecordStatus;
    courseCode: string;
    courseTitle: string;
  } | null>(null);

  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadError(null);
      try {
        const result = await listEligibleAttendanceSessions();
        if (!cancelled) {
          setSessions(result.data);
        }
      } catch (error) {
        if (!cancelled) {
          setSessions(null);
          setLoadError(attendanceErrorMessage(error));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function handleMark(session: EligibleAttendanceSession) {
    if (markingSessionId !== null) {
      return;
    }

    setMarkError(null);
    setConfirmation(null);
    setMarkingSessionId(session.id);

    try {
      if (!isWebAuthnSupported()) {
        throw new WebAuthnUnsupportedError();
      }
      const challenge = await requestAttendanceDeviceChallenge();
      const assertion = await getDeviceAssertion(challenge.data);
      const marked = await markSessionAttendance(session.id, assertion);

      setConfirmation({
        status: marked.data.status,
        courseCode: marked.data.courseCode,
        courseTitle: marked.data.courseTitle,
      });

      const result = await listEligibleAttendanceSessions();
      setSessions(result.data);
    } catch (error) {
      setMarkError(markErrorMessage(error));
      const result = await listEligibleAttendanceSessions().catch(() => null);
      if (result !== null) {
        setSessions(result.data);
      }
    } finally {
      setMarkingSessionId(null);
    }
  }

  async function handleLogout() {
    if (user === null || isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate("/login", { replace: true });
  }

  if (user === null) {
    return (
      <main className="loading-page" role="status">
        Loading…
      </main>
    );
  }

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Attendance</h1>
          <p className="app-header__sub">
            Mark your attendance with your enrolled device.
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

      <section className="app-card app-card--wide" aria-labelledby="eligible-heading">
        <h2 id="eligible-heading">Sessions to Mark</h2>

        {confirmation !== null ? (
          <p className="mark-confirmation" role="status">
            Attendance marked as <strong>{confirmation.status}</strong> for{" "}
            {confirmation.courseCode} · {confirmation.courseTitle}.
          </p>
        ) : null}

        {sessions === null && loadError === null ? (
          <p className="inline-status" role="status">
            Loading attendance sessions…
          </p>
        ) : null}

        {loadError !== null ? (
          <div className="resource-error">
            <FormError message={loadError} />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}

        {sessions !== null && sessions.length === 0 ? (
          <p className="inline-status">
            No attendance sessions are currently available.
          </p>
        ) : null}

        {sessions !== null && sessions.length > 0 ? (
          <>
            {markError !== null ? <FormError message={markError} /> : null}
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id} className="session-list__item">
                  <p className="session-list__title">
                    {session.courseCode} — {session.courseTitle}
                  </p>
                  <p className="session-list__meta">
                    {session.attendanceNetworkName} · {session.locationName}
                  </p>
                  <p className="session-list__meta">
                    {formatDateTime(session.startTime)} –{" "}
                    {formatDateTime(session.endTime)}
                  </p>
                  <p className="session-list__meta">
                    Late threshold: {session.lateThresholdMinutes} minutes
                  </p>

                  {session.currentAttendanceState === "PRESENT" ? (
                    <p className="attendance-state attendance-state--present">
                      Present
                    </p>
                  ) : null}
                  {session.currentAttendanceState === "LATE" ? (
                    <p className="attendance-state attendance-state--late">
                      Late
                    </p>
                  ) : null}

                  {session.currentAttendanceState === "NOT_MARKED" ? (
                    <div className="session-mark">
                      <button
                        type="button"
                        className="auth-submit"
                        aria-label={`Mark attendance for ${session.courseCode}`}
                        disabled={markingSessionId !== null}
                        aria-busy={markingSessionId === session.id}
                        onClick={() => handleMark(session)}
                      >
                        {markingSessionId === session.id
                          ? "Verifying…"
                          : "Mark attendance"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </main>
  );
}