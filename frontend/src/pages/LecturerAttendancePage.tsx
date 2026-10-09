import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import { statusLabel } from "../lib/format";
import {
  createAttendanceSession,
  endAttendanceSession,
  listAttendanceSessions,
  listCourseOfferings,
} from "../api/attendance";
import type {
  AttendanceSession,
  LecturerCourseOffering,
} from "../types/attendance";

const DURATION_PRESETS = [30, 45, 60, 90, 120];
const LATE_THRESHOLD_PRESETS = [0, 5, 10, 15, 20, 30];
const CUSTOM = "custom";

type PresetValue = number | typeof CUSTOM;

interface FormFieldErrors {
  offeringId?: string;
  durationMinutes?: string;
  lateThresholdMinutes?: string;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function remainingLabel(endTime: string, now: number): string {
  const ms = new Date(endTime).getTime() - now;
  if (ms <= 0) {
    return "This session has just expired.";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s remaining`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function LecturerAttendancePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<AttendanceSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [offerings, setOfferings] = useState<LecturerCourseOffering[] | null>(null);
  const [offeringsError, setOfferingsError] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const [offeringId, setOfferingId] = useState("");
  const [durationPreset, setDurationPreset] = useState<PresetValue>(60);
  const [customDuration, setCustomDuration] = useState("");
  const [latePreset, setLatePreset] = useState<PresetValue>(5);
  const [customLate, setCustomLate] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const offeringSelectId = useId();
  const customDurationId = useId();
  const customLateId = useId();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [sessionsResult, offeringsResult] =
        await Promise.allSettled([
          listAttendanceSessions(),
          listCourseOfferings(),
        ]);

      if (cancelled) {
        return;
      }

      if (sessionsResult.status === "fulfilled") {
        setSessions(sessionsResult.value.data);
      } else {
        setSessionsError(attendanceErrorMessage(sessionsResult.reason));
      }
      if (offeringsResult.status === "fulfilled") {
        setOfferings(offeringsResult.value.data);
      } else {
        setOfferingsError(attendanceErrorMessage(offeringsResult.reason));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function refreshSessions() {
    setSessionsError(null);
    try {
      const result = await listAttendanceSessions();
      setSessions(result.data);
    } catch (error) {
      setSessionsError(attendanceErrorMessage(error));
    }
  }

  const activeSession = useMemo(
    () =>
      sessions === null
        ? undefined
        : sessions.find((session) => session.status === "ACTIVE"),
    [sessions]
  );

  const history = useMemo(
    () =>
      sessions === null
        ? null
        : sessions.filter((session) => session.id !== activeSession?.id),
    [sessions, activeSession]
  );

  const blocked =
    activeSession !== undefined && activeSession.currentState === "ACTIVE";

  const durationMinutes = useMemo(
    () =>
      durationPreset === CUSTOM ? Number(customDuration) : durationPreset,
    [durationPreset, customDuration]
  );

  const lateThresholdMinutes = useMemo(
    () => (latePreset === CUSTOM ? Number(customLate) : latePreset),
    [latePreset, customLate]
  );

  useEffect(() => {
    if (activeSession?.currentState !== "ACTIVE") {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeSession?.id, activeSession?.currentState]);

  const selectedOffering = offerings?.find(
    (offering) => offering.id === Number(offeringId)
  );

  function validateForm(): FormFieldErrors {
    const errors: FormFieldErrors = {};

    if (offeringId === "") {
      errors.offeringId = "Please select a course offering.";
    }

    if (durationPreset === CUSTOM) {
      if (
        customDuration.trim() === "" ||
        !Number.isInteger(durationMinutes) ||
        durationMinutes < 1 ||
        durationMinutes > 480
      ) {
        errors.durationMinutes =
          "Duration must be a whole number between 1 and 480 minutes.";
      }
    }

    if (latePreset === CUSTOM) {
      if (
        customLate.trim() === "" ||
        !Number.isInteger(lateThresholdMinutes) ||
        lateThresholdMinutes < 0 ||
        lateThresholdMinutes > 120
      ) {
        errors.lateThresholdMinutes =
          "Late threshold must be a whole number between 0 and 120 minutes.";
      }
    }

    const durationValid =
      durationPreset === CUSTOM ? errors.durationMinutes === undefined : true;
    const lateValid =
      latePreset === CUSTOM ? errors.lateThresholdMinutes === undefined : true;

    if (
      durationValid &&
      lateValid &&
      durationMinutes > 0 &&
      lateThresholdMinutes > durationMinutes
    ) {
      errors.lateThresholdMinutes =
        "Late threshold cannot exceed the session duration.";
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    setFormError(null);
    const errors = validateForm();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      await createAttendanceSession({
        courseOfferingId: Number(offeringId),
        durationMinutes,
        lateThresholdMinutes,
      });
      setOfferingId("");
      setDurationPreset(60);
      setCustomDuration("");
      setLatePreset(5);
      setCustomLate("");
      setFieldErrors({});
      setConfirmingEnd(false);
      setEndError(null);
      await refreshSessions();
    } catch (error) {
      setFormError(attendanceErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleEnd() {
    if (activeSession === undefined || isEnding) {
      return;
    }

    setIsEnding(true);
    setEndError(null);
    try {
      await endAttendanceSession(activeSession.id);
      setConfirmingEnd(false);
      await refreshSessions();
    } catch (error) {
      setEndError(attendanceErrorMessage(error));
      await refreshSessions();
    } finally {
      setIsEnding(false);
    }
  }

  async function handleLogout() {
    if (user === null || isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate("/staff/lecturer/login", { replace: true });
  }

  if (user === null) {
    return (
      <main className="loading-page" role="status">
        Loading…
      </main>
    );
  }

  const catalogHasError = offeringsError !== null;
  const catalogLoading = offerings === null && offeringsError === null;

  const offeringSummary = selectedOffering
    ? `${selectedOffering.courseCode} · ${selectedOffering.courseTitle} (Level ${selectedOffering.levelName}, ${selectedOffering.semesterName})`
    : "";
  return (
    <main className="app-page lecturer-attendance-page">
      <header className="app-header lecturer-attendance-header">
        <div className="lecturer-attendance-header__copy">
          <p className="lecturer-attendance-header__eyebrow">Lecturer attendance</p>
          <h1>Attendance sessions</h1>
          <p className="app-header__sub">
            Start a session, then end it when the lecture is over.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Lecturer navigation">
          <Link to={homePathForRole("LECTURER")}>Home</Link>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </header>

      <section
        className="app-card app-card--wide lecturer-attendance-section lecturer-current-section"
        aria-labelledby="current-heading"
      >
        <h2 id="current-heading">Current session</h2>

        {sessions === null && sessionsError === null ? (
          <p className="inline-status" role="status">
            Loading current session…
          </p>
        ) : null}

        {sessionsError !== null ? (
          <div className="resource-error">
            <FormError message={sessionsError} />
            <button type="button" className="secondary-button" onClick={refreshSessions}>
              Retry
            </button>
          </div>
        ) : null}

        {sessions !== null && activeSession === undefined ? (
          <p className="inline-status" role="status">
            No active session.
          </p>
        ) : null}

        {activeSession !== undefined ? (
          <div className="session-detail lecturer-current-session">
            <p className="session-detail__title lecturer-current-session__title">
              {activeSession.courseCode} · {activeSession.courseTitle}
            </p>
            <p>
              <span className="app-detail__label">Status: </span>
              <span className={`session-status session-status--${activeSession.currentState.toLowerCase()}`}>
                {statusLabel(activeSession.currentState)}
              </span>
            </p>
            <div className="lecturer-session-timing">
              <div className="lecturer-session-timing__item">
                <p className="lecturer-session-timing__label">Session time</p>
                <p>
                  <span className="app-detail__label">Started: </span>
                  {formatDateTime(activeSession.startTime)}
                </p>
                <p>
                  <span className="app-detail__label">Scheduled end: </span>
                  {formatDateTime(activeSession.endTime)}
                </p>
              </div>
              <div className="lecturer-session-timing__item lecturer-session-timing__item--threshold">
                <p className="lecturer-session-timing__label">Late threshold</p>
                <p>
                  <span className="app-detail__label">Minutes allowed: </span>
                  {activeSession.lateThresholdMinutes}
                </p>
              </div>
            </div>

            {/*
              A countdown that re-renders every second must not be a live
              region: announcing every tick would flood a screen reader.
            */}
            {activeSession.currentState === "ACTIVE" ? (
              <p className="session-detail__countdown" role="timer">
                {remainingLabel(activeSession.endTime, now)}
              </p>
            ) : null}

            {activeSession.currentState === "EXPIRED" ? (
              <p className="session-detail__expired">
                This session has expired and can no longer be used. You can start a
                new session.
              </p>
            ) : null}

            {activeSession.currentState === "ACTIVE" ? (
              <div className="session-end">
                {endError !== null ? <FormError message={endError} /> : null}
                {confirmingEnd ? (
                  <div className="confirm-row">
                    <span>End this session now?</span>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={handleEnd}
                      disabled={isEnding}
                      aria-busy={isEnding}
                    >
                      {isEnding ? "Ending…" : "Confirm end"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setConfirmingEnd(false)}
                      disabled={isEnding}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => setConfirmingEnd(true)}
                    disabled={isEnding}
                  >
                    End session
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className="app-card app-card--wide lecturer-attendance-section lecturer-start-section"
        aria-labelledby="start-heading"
      >
        <h2 id="start-heading">Start an attendance session</h2>

        {catalogLoading ? (
          <p className="inline-status" role="status">
            Loading session options…
          </p>
        ) : null}

        {catalogHasError ? (
          <div className="resource-error">
            <FormError message="Some session options could not be loaded." />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}

        {!catalogLoading && !catalogHasError ? (
          <>
            {blocked ? (
              <p className="note" role="status">
                You already have an active session. End it before starting a new one.
              </p>
            ) : null}

            {offerings !== null && offerings.length === 0 ? (
              <p className="note" role="status">
                No course offerings are currently available for you to start a
                session.
              </p>
            ) : null}

            <form onSubmit={handleSubmit} noValidate>
              <fieldset disabled={blocked} className="form-fields">
                {formError !== null ? <FormError message={formError} /> : null}

                <div className="field">
                  <label htmlFor={offeringSelectId} className="field__label">
                    Course offering
                  </label>
                  <select
                    id={offeringSelectId}
                    name="courseOfferingId"
                    className="field__input"
                    value={offeringId}
                    onChange={(event) => setOfferingId(event.target.value)}
                    aria-invalid={fieldErrors.offeringId !== undefined || undefined}
                  >
                    <option value="">Select a course offering…</option>
                    {offerings?.map((offering) => (
                      <option key={offering.id} value={offering.id}>
                        {offering.courseCode} · {offering.courseTitle} (Level{" "}
                        {offering.levelName}, {offering.semesterName},{" "}
                        {offering.academicSessionName})
                      </option>
                    ))}
                  </select>
                  {fieldErrors.offeringId !== undefined ? (
                    <p className="field__error">{fieldErrors.offeringId}</p>
                  ) : null}
                </div>

                <div className="field">
                  <fieldset className="preset-fieldset">
                    <legend className="field__label">Duration</legend>
                    <div className="preset-options">
                      {DURATION_PRESETS.map((minutes) => (
                        <label key={minutes} className="preset-option">
                          <input
                            type="radio"
                            name="durationPreset"
                            value={minutes}
                            checked={durationPreset === minutes}
                            onChange={() => setDurationPreset(minutes)}
                          />
                          <span>{minutes} min</span>
                        </label>
                      ))}
                      <label className="preset-option">
                        <input
                          type="radio"
                          name="durationPreset"
                          value={CUSTOM}
                          checked={durationPreset === CUSTOM}
                          onChange={() => setDurationPreset(CUSTOM)}
                        />
                        <span>Custom</span>
                      </label>
                    </div>
                  </fieldset>
                  {durationPreset === CUSTOM ? (
                    <div className="field field--inner">
                      <label htmlFor={customDurationId} className="field__label">
                        Duration in minutes
                      </label>
                      <input
                        id={customDurationId}
                        name="customDuration"
                        className="field__input"
                        type="number"
                        min={1}
                        max={480}
                        step={1}
                        value={customDuration}
                        onChange={(event) => setCustomDuration(event.target.value)}
                        aria-invalid={fieldErrors.durationMinutes !== undefined || undefined}
                      />
                    </div>
                  ) : null}
                  {fieldErrors.durationMinutes !== undefined ? (
                    <p className="field__error">{fieldErrors.durationMinutes}</p>
                  ) : null}
                </div>

                <div className="field">
                  <fieldset className="preset-fieldset">
                    <legend className="field__label">Late threshold</legend>
                    <div className="preset-options">
                      {LATE_THRESHOLD_PRESETS.map((minutes) => (
                        <label key={minutes} className="preset-option">
                          <input
                            type="radio"
                            name="latePreset"
                            value={minutes}
                            checked={latePreset === minutes}
                            onChange={() => setLatePreset(minutes)}
                          />
                          <span>{minutes} min</span>
                        </label>
                      ))}
                      <label className="preset-option">
                        <input
                          type="radio"
                          name="latePreset"
                          value={CUSTOM}
                          checked={latePreset === CUSTOM}
                          onChange={() => setLatePreset(CUSTOM)}
                        />
                        <span>Custom</span>
                      </label>
                    </div>
                  </fieldset>
                  {latePreset === CUSTOM ? (
                    <div className="field field--inner">
                      <label htmlFor={customLateId} className="field__label">
                        Late threshold in minutes
                      </label>
                      <input
                        id={customLateId}
                        name="customLate"
                        className="field__input"
                        type="number"
                        min={0}
                        max={120}
                        step={1}
                        value={customLate}
                        onChange={(event) => setCustomLate(event.target.value)}
                        aria-invalid={
                          fieldErrors.lateThresholdMinutes !== undefined || undefined
                        }
                      />
                    </div>
                  ) : null}
                  {fieldErrors.lateThresholdMinutes !== undefined ? (
                    <p className="field__error">
                      {fieldErrors.lateThresholdMinutes}
                    </p>
                  ) : null}
                </div>

                <div className="session-summary" aria-live="polite">
                  <p className="session-summary__title">Summary</p>
                  <p>
                    <span className="app-detail__label">Course offering: </span>
                    {offeringSummary || "Not selected"}
                  </p>
                  <p>
                    <span className="app-detail__label">Duration: </span>
                    {durationPreset === CUSTOM
                      ? customDuration.trim() !== "" && Number.isInteger(durationMinutes)
                        ? formatDuration(durationMinutes)
                        : "Not set"
                      : formatDuration(durationPreset)}
                  </p>
                  <p>
                    <span className="app-detail__label">Late threshold: </span>
                    {latePreset === CUSTOM
                      ? customLate.trim() !== "" && Number.isInteger(lateThresholdMinutes)
                        ? `${lateThresholdMinutes} min`
                        : "Not set"
                      : `${latePreset} min`}
                  </p>
                </div>

                <button
                  type="submit"
                  className="auth-submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                >
                  {isSubmitting ? "Starting…" : "Start session"}
                </button>
              </fieldset>
            </form>
          </>
        ) : null}
      </section>

      <section
        className="app-card app-card--wide lecturer-attendance-section lecturer-history-section"
        aria-labelledby="history-heading"
      >
        <h2 id="history-heading">Session history</h2>

        {sessions === null && sessionsError === null ? (
          <p className="inline-status" role="status">
            Loading history…
          </p>
        ) : null}

        {sessionsError !== null ? (
          <FormError message={sessionsError} />
        ) : null}

        {history !== null && history.length === 0 ? (
          <p className="inline-status" role="status">
            No past sessions yet.
          </p>
        ) : null}

        {history !== null && history.length > 0 ? (
          <ul className="session-list lecturer-session-list">
            {history.map((session) => (
              <li
                key={session.id}
                className="session-list__item lecturer-session-record"
              >
                <div className="lecturer-session-record__header">
                  <div>
                    <p className="lecturer-session-record__code">
                      {session.courseCode}
                    </p>
                    <h3 className="session-list__title lecturer-session-record__title">
                      {session.courseTitle}
                    </h3>
                  </div>
                  <span
                    className={`session-status session-status--${session.currentState.toLowerCase()}`}
                  >
                    {statusLabel(session.currentState)}
                  </span>
                </div>

                <div className="lecturer-session-record__timing">
                  <div className="lecturer-session-timing__item">
                    <p className="lecturer-session-timing__label">Session time</p>
                    <p className="session-list__title">
                      <span className="app-detail__label">Started: </span>
                      {formatDateTime(session.startTime)}
                      {session.endedAt !== null
                        ? `, ended ${formatDateTime(session.endedAt)}`
                        : ""}
                    </p>
                  </div>
                  <div className="lecturer-session-timing__item lecturer-session-timing__item--threshold">
                    <p className="lecturer-session-timing__label">Late threshold</p>
                    <p className="session-list__meta">
                      <span className="app-detail__label">Minutes allowed: </span>
                      {session.lateThresholdMinutes}
                    </p>
                  </div>
                </div>

                {session.currentState === "ENDED" ? (
                  <div className="lecturer-session-record__action">
                    <Link
                      className="secondary-button"
                      to={`/app/lecturer/attendance-reports/session/${session.id}`}
                    >
                      View Attendance
                    </Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}