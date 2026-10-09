import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import { getLecturerSessionAttendanceReport } from "../api/attendance";
import {
  downloadLecturerSessionAttendanceReport,
} from "../lib/lecturerAttendanceExcel";
import { NOT_AVAILABLE, statusLabel } from "../lib/format";
import type { LecturerSessionAttendanceReport } from "../types/attendance";

function sessionReportErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You are not authorized to view attendance reports.";
    }
    if (error.status === 404) {
      return "The attendance session could not be found. It may have been removed or has not ended yet.";
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



function parseSessionIdParam(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function isValidReport(payload: unknown): payload is LecturerSessionAttendanceReport {
  if (payload === null || typeof payload !== "object") {
    return false;
  }
  const report = payload as LecturerSessionAttendanceReport;
  return (
    report.session !== null &&
    typeof report.session === "object" &&
    Array.isArray(report.students)
  );
}

export function LecturerSessionAttendanceReportPage() {
  const { attendanceSessionId } = useParams<{ attendanceSessionId: string }>();
  const sessionId = parseSessionIdParam(attendanceSessionId);

  const [report, setReport] = useState<LecturerSessionAttendanceReport | null>(
    null
  );
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(sessionId !== null);
  const [reportReloadKey, setReportReloadKey] = useState(0);
  const inflightKeyRef = useRef<string | null>(null);
  const inflightPromiseRef =
    useRef<Promise<{ data: LecturerSessionAttendanceReport }> | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null) {
      return;
    }
    // A single in-flight report request is shared across rendered views of
    // this page (including the strict-mode double effect in development), so
    // mounting the page never fires a second report request. Retry bumps
    // reportReloadKey, which invalidates the shared request.
    const requestKey = `${sessionId}:${reportReloadKey}`;
    if (inflightKeyRef.current !== requestKey) {
      inflightKeyRef.current = requestKey;
      inflightPromiseRef.current = getLecturerSessionAttendanceReport(sessionId);
    }

    let cancelled = false;
    const request = inflightPromiseRef.current;
    if (request === null) {
      return;
    }

    request
      .then((res) => {
        if (!isValidReport(res.data)) {
          throw new TypeError("Unexpected attendance session report response.");
        }
        if (!cancelled) {
          setReport(res.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReportError(sessionReportErrorMessage(error));
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
  }, [sessionId, reportReloadKey]);

  function retryReport(): void {
    if (sessionId === null) {
      return;
    }
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
      await downloadLecturerSessionAttendanceReport(report);
    } catch {
      setExportError(
        "The Excel export could not be generated. Please try again."
      );
    } finally {
      setExporting(false);
    }
  }

  if (sessionId === null) {
    return (
      <main className="app-page lecturer-reports-page">
        <header className="app-header lecturer-reports-header">
          <div className="lecturer-reports-header__copy">
            <p className="lecturer-reports-header__eyebrow">Lecturer attendance</p>
            <h1>Session attendance report</h1>
          </div>
          <nav className="app-header__nav" aria-label="Lecturer navigation">
            <Link to="/app/lecturer/attendance">Back to attendance sessions</Link>
          </nav>
        </header>
        <section
          className="app-card app-card--wide lecturer-report-workspace"
          aria-labelledby="session-report-error-heading"
        >
          <div className="resource-error">
            <h2 id="session-report-error-heading">Report unavailable</h2>
            <p role="alert" className="form-error">
              The attendance session could not be found.
            </p>
          </div>
        </section>
      </main>
    );
  }

  const session = report?.session ?? null;
  const students = report?.students ?? null;

  const presentCount =
    students?.filter((student) => student.status === "PRESENT").length ?? 0;
  const lateCount =
    students?.filter((student) => student.status === "LATE").length ?? 0;
  const absentCount =
    students?.filter((student) => student.status === "ABSENT").length ?? 0;

  return (
    <main className="app-page lecturer-reports-page">
      <header className="app-header lecturer-reports-header">
        <div className="lecturer-reports-header__copy">
          <p className="lecturer-reports-header__eyebrow">Lecturer attendance</p>
          <h1>Session attendance report</h1>
          <p className="app-header__sub">
            Attendance for one completed session.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Lecturer navigation">
          <Link to="/app/lecturer/attendance">Back to attendance sessions</Link>
        </nav>
      </header>

      <section
        className="app-card app-card--wide lecturer-report-workspace"
        aria-labelledby="session-report-heading"
      >
        <div className="admin-detail__header">
          <h2 id="session-report-heading">Session attendance report</h2>
        </div>
        {reportError !== null ? (
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
            Loading attendance session report…
          </p>
        ) : session !== null && students !== null ? (
          <>
            <div className="session-detail admin-detail lecturer-report-context">
              <p>
                <span className="app-detail__label">Course: </span>
                {session.courseCode} · {session.courseTitle}
              </p>
              <p>
                <span className="app-detail__label">Academic session: </span>
                {session.academicSession} · {session.semester}
              </p>
              <p>
                <span className="app-detail__label">Level: </span>Level{" "}
                {session.level}
              </p>
              <p>
                <span className="app-detail__label">Lecturer: </span>
                {session.startedByLecturer.name} (
                {session.startedByLecturer.staffId})
              </p>
              <p>
                <span className="app-detail__label">Started: </span>
                {formatDateTime(session.startTime)}
              </p>
              <p>
                <span className="app-detail__label">Ended: </span>
                {formatDateTime(session.endTime)}
              </p>
              <p>
                <span className="app-detail__label">Late threshold: </span>
                {session.lateThresholdMinutes} minutes
              </p>
            </div>

            <hr className="admin-detail__divider lecturer-report-divider" />

            <div className="report-actions lecturer-report-actions">
              <p className="inline-status" role="status">
                {students.length === 1
                  ? "1 student"
                  : `${students.length} students`}{" "}
                · {presentCount} present · {lateCount} late · {absentCount}{" "}
                absent
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

            {students.length === 0 ? (
              <div className="admin-empty">
                <p className="admin-empty__message" role="status">
                  No attendance was recorded for this session.
                </p>
              </div>
            ) : (
              <div className="admin-table-scroll lecturer-report-table-wrap">
                <table className="admin-table lecturer-report-table">
                  <thead>
                    <tr>
                      <th scope="col">Student</th>
                      <th scope="col">Matric Number</th>
                      <th scope="col">Status</th>
                      <th scope="col">Marked At</th>
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
                        <td data-label="Matric Number">{student.matricNumber}</td>
                        <td data-label="Status">
                          <span
                            className={`history-status history-status--${student.status.toLowerCase()}`}
                          >
                            {statusLabel(student.status)}
                          </span>
                        </td>
                        <td data-label="Marked At">
                          {student.markedAt !== null
                            ? formatDateTime(student.markedAt)
                            : NOT_AVAILABLE}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
