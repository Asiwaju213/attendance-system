import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import {
  getLecturerCourseOfferingReport,
  listCourseOfferings,
} from "../api/attendance";
import { downloadLecturerSemesterAttendanceReport } from "../lib/lecturerAttendanceExcel";
import type {
  LecturerAttendanceReport,
  LecturerCourseOffering,
  LecturerReportAttendanceStatus,
} from "../types/attendance";

interface Option {
  value: string;
  label: string;
}

function reportErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You are not authorized to view attendance reports.";
    }
    if (error.status === 404) {
      return "The selected course offering could not be found. It may have been removed.";
    }
    if (error.status === 500) {
      return "The report could not be generated right now. Please try again later.";
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

function statusLabel(status: LecturerReportAttendanceStatus): string {
  switch (status) {
    case "PRESENT":
      return "Present";
    case "LATE":
      return "Late";
    case "ABSENT":
      return "Absent";
  }
}

export function LecturerAttendanceReportsPage() {
  const [offerings, setOfferings] = useState<LecturerCourseOffering[] | null>(
    null
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);
  const inflightCatalogReloadKeyRef = useRef<number | null>(null);
  const inflightCatalogPromiseRef =
    useRef<Promise<{ data: LecturerCourseOffering[] }> | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<LecturerAttendanceReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportReloadKey, setReportReloadKey] = useState(0);
  const loadedForId = useRef<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    // A single in-flight catalog request is shared across rendered views of
    // this page (including the strict-mode double effect in development), so
    // rendering the page never fires a second catalog request. The Retry
    // button bumps catalogReloadKey, which invalidates the shared request.
    const reloadKeyChanged =
      inflightCatalogReloadKeyRef.current !== catalogReloadKey;
    if (reloadKeyChanged) {
      inflightCatalogReloadKeyRef.current = catalogReloadKey;
      inflightCatalogPromiseRef.current = listCourseOfferings();
    }

    let cancelled = false;
    const request = inflightCatalogPromiseRef.current;
    if (request === null) {
      return;
    }

    request
      .then((res) => {
        if (!cancelled) {
          setOfferings(res.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError(
            "The course offerings could not be loaded. Please try again."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [catalogReloadKey]);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    if (loadedForId.current === selectedId) {
      return;
    }
    let cancelled = false;
    loadedForId.current = selectedId;
    getLecturerCourseOfferingReport(selectedId)
      .then((res) => {
        const payload = res.data;
        if (
          payload === null ||
          typeof payload !== "object" ||
          payload.courseOffering === null ||
          typeof payload.courseOffering !== "object" ||
          !Array.isArray(payload.students)
        ) {
          throw new TypeError("Unexpected attendance report response.");
        }
        if (!cancelled) {
          setReport(payload);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReportError(reportErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReportLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, reportReloadKey]);

  function reloadOfferings(): void {
    setCatalogError(null);
    setOfferings(null);
    setCatalogReloadKey((prev) => prev + 1);
  }

  function handleOfferingChange(value: string): void {
    const id = value === "" ? null : Number(value);
    if (id === selectedId) {
      return;
    }
    loadedForId.current = null;
    setSelectedId(id);
    setReport(null);
    setReportError(null);
    setReportLoading(id !== null);
    setExportError(null);
  }

  function retryReport(): void {
    if (selectedId === null) {
      return;
    }
    loadedForId.current = null;
    setReport(null);
    setReportError(null);
    setReportLoading(true);
    setReportReloadKey((prev) => prev + 1);
  }

  async function handleExport(): Promise<void> {
    if (report === null || exporting) {
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      await downloadLecturerSemesterAttendanceReport(report);
    } catch {
      setExportError(
        "The Excel file could not be generated. Please try again."
      );
    } finally {
      setExporting(false);
    }
  }

  const offeringOptions: Option[] = useMemo(
    () =>
      (offerings ?? [])
        .map((offering) => ({
          value: String(offering.id),
          label: `${offering.courseCode} — ${offering.courseTitle} · ${offering.academicSessionName} · ${offering.semesterName}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [offerings]
  );

  const catalogLoading = offerings === null && catalogError === null;

  const context = report?.courseOffering ?? null;
  const students = report?.students ?? null;
  const noEnrolledStudents =
    context !== null && students !== null && students.length === 0;
  const noCompletedSessions =
    context !== null && context.totalCompletedSessions === 0;

  return (
    <main className="app-page lecturer-reports-page">
      <header className="app-header lecturer-reports-header">
        <div className="lecturer-reports-header__copy">
          <p className="lecturer-reports-header__eyebrow">Lecturer records</p>
          <h1>Attendance Reports</h1>
          <p className="app-header__sub">
            Attendance summaries for your course offerings.
          </p>
        </div>
        <nav className="app-header__nav">
          <Link to="/app/lecturer">Back to Lecturer Home</Link>
        </nav>
      </header>

      <section
        className="app-card app-card--wide lecturer-report-selector"
        aria-labelledby="report-offering-title"
      >
        <h2 id="report-offering-title">Choose a course offering</h2>
        {catalogError !== null ? (
          <div className="resource-error admin-filter-catalog-error">
            <p className="form-error" role="alert">
              {catalogError}
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={reloadOfferings}
              aria-busy={catalogLoading}
            >
              Retry options
            </button>
          </div>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="report-offering">
              Course offering
            </label>
            <select
              id="report-offering"
              className="field__input"
              value={selectedId === null ? "" : String(selectedId)}
              onChange={(event) => handleOfferingChange(event.target.value)}
            >
              <option value="">Select a course offering…</option>
              {offeringOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section
        className="app-card app-card--wide lecturer-report-workspace"
        aria-label="Attendance report"
      >
        {selectedId === null ? (
          <div className="admin-empty">
            <p className="form-error admin-empty__message" role="status">
              Select a course offering to view its attendance report.
            </p>
            <p className="inline-status">
              Reports include only ended sessions and currently enrolled
              students.
            </p>
          </div>
        ) : reportError !== null ? (
          <div className="resource-error">
            <p role="alert" className="form-error">
              {reportError}
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={retryReport}
            >
              Retry
            </button>
          </div>
        ) : reportLoading ? (
          <p className="inline-status" aria-busy>
            Loading attendance report…
          </p>
        ) : context !== null && students !== null ? (
          <>
             <div className="session-detail admin-detail lecturer-report-context">
              <p>
                <span className="app-detail__label">Course: </span>
                {context.courseCode} — {context.courseTitle}
              </p>
              <p>
                <span className="app-detail__label">Academic session: </span>
                {context.academicSession} · {context.semester}
              </p>
              <p>
                <span className="app-detail__label">Level: </span>Level{" "}
                {context.level}
              </p>
              <p>
                <span className="app-detail__label">Lecturer: </span>
                {context.lecturer.name} ({context.lecturer.staffId})
              </p>
              <p>
                <span className="app-detail__label">Completed sessions: </span>
                {context.totalCompletedSessions === 1
                  ? "1 session"
                  : `${context.totalCompletedSessions} sessions`}
              </p>
            </div>

             <div className="report-actions lecturer-report-actions">
              <p className="inline-status" role="status">
                {students.length === 1
                  ? "1 student"
                  : `${students.length} students`}{" "}
                · {students.reduce((sum, s) => sum + s.presentCount, 0)} present ·{" "}
                {students.reduce((sum, s) => sum + s.lateCount, 0)} late ·{" "}
                {students.reduce((sum, s) => sum + s.absentCount, 0)} absent
              </p>
              {exportError !== null ? (
                <p className="form-error" role="alert">
                  {exportError}
                </p>
              ) : null}
              <button
                type="button"
                className="secondary-button"
                onClick={handleExport}
                disabled={exporting || students.length === 0}
                aria-busy={exporting}
              >
                {exporting ? "Generating…" : "Export Excel"}
              </button>
            </div>

             <hr className="admin-detail__divider lecturer-report-divider" />

            {noEnrolledStudents ? (
              <div className="admin-empty">
                <p className="form-error admin-empty__message" role="status">
                  No students are enrolled in this course offering.
                </p>
              </div>
            ) : (
              <>
                {noCompletedSessions ? (
                  <p className="inline-status" role="status">
                    No attendance sessions have ended for this course offering
                    yet. Percentages will appear once sessions are completed.
                  </p>
                ) : null}
                 <div className="admin-table-scroll lecturer-report-table-wrap">
                   <table className="admin-table lecturer-report-table">
                    <thead>
                      <tr>
                        <th scope="col">Student</th>
                        <th scope="col">Matric No.</th>
                        <th scope="col">Sessions</th>
                        <th scope="col">Present</th>
                        <th scope="col">Late</th>
                        <th scope="col">Absent</th>
                        <th scope="col">Attendance %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {students.map((student) => (
                        <tr key={student.studentId} className="admin-table__row">
                          <td data-label="Student">
                            <span className="admin-table__primary">
                              {student.studentName}
                            </span>
                          </td>
                          <td data-label="Matric No.">{student.matricNumber}</td>
                          <td data-label="Sessions">{student.totalCompletedSessions}</td>
                          <td data-label="Present">{student.presentCount}</td>
                          <td data-label="Late">{student.lateCount}</td>
                          <td data-label="Absent">{student.absentCount}</td>
                          <td data-label="Attendance %">
                            {formatPercentage(student.attendancePercentage)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <h3 className="history-sessions__heading">
                  Session details by student
                </h3>
                {students.map((student) => (
                   <div key={student.studentId} className="student-report lecturer-student-report">
                    <div className="student-report__header">
                      <div>
                        <p className="student-report__name">
                          {student.studentName}
                        </p>
                        <p className="session-list__meta">
                          {student.matricNumber} · {student.presentCount}{" "}
                          present · {student.lateCount} late ·{" "}
                          {student.absentCount} absent
                        </p>
                      </div>
                      <p className="session-list__meta">
                        {formatPercentage(student.attendancePercentage)}{" "}
                        attendance
                      </p>
                    </div>
                    <details className="student-sessions">
                      <summary className="student-sessions__summary">
                        {student.sessions.length === 0
                          ? "No sessions"
                          : `View sessions (${student.sessions.length})`}
                      </summary>
                       <ul className="session-list lecturer-report-session-list">
                        {student.sessions.map((session) => (
                          <li
                            key={session.sessionId}
                             className="session-list__item lecturer-report-session-record"
                          >
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
                            {session.markedAt !== null ? (
                              <p className="session-list__meta">
                                Marked at {formatDateTime(session.markedAt)}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                ))}
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}

