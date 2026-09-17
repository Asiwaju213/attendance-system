import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { attendanceErrorMessage } from "../app/attendanceErrors";
import {
  getCourseOfferingAttendanceReport,
  listAdminCourseOfferings,
} from "../api/attendance";
import { downloadAttendanceReport } from "../lib/attendanceReportExcel";
import type {
  AdminCourseOffering,
  CourseOfferingAttendanceReport,
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

function formatPercentage(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

export function AdminAttendanceReportsPage() {
  const [offerings, setOfferings] = useState<AdminCourseOffering[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<CourseOfferingAttendanceReport | null>(
    null
  );
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportReloadKey, setReportReloadKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const loadedForId = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAdminCourseOfferings()
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
    getCourseOfferingAttendanceReport(selectedId)
      .then((res) => {
        if (!cancelled) {
          setReport(res.data);
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
      await downloadAttendanceReport(report);
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
  const noEnrolledStudents = context !== null && students !== null && students.length === 0;
  const noCompletedSessions =
    context !== null && context.totalCompletedSessions === 0;
  const canExport = report !== null && !reportLoading && !exporting;

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Attendance Reports</h1>
          <p className="app-header__sub">
            Attendance summaries for a course offering.
          </p>
        </div>
        <nav className="app-header__nav">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="report-offering-title">
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
        className="app-card app-card--wide"
        aria-label="Attendance report"
      >
        <div className="admin-detail__header">
          <h2>Report</h2>
          <div className="report-actions">
            {exportError !== null ? (
              <p role="alert" className="form-error">
                {exportError}
              </p>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              onClick={handleExport}
              disabled={!canExport}
              aria-busy={exporting}
            >
              {exporting ? "Generating…" : "Export Excel"}
            </button>
          </div>
        </div>
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
            <div className="session-detail admin-detail">
              <p>
                <span className="app-detail__label">Course: </span>
                {context.courseCode} — {context.courseTitle}
              </p>
              <p>
                <span className="app-detail__label">Academic session: </span>
                {context.academicSessionName} · {context.semesterName}
              </p>
              <p>
                <span className="app-detail__label">Level: </span>
                Level {context.levelName}
              </p>
              <p>
                <span className="app-detail__label">Lecturers: </span>
                {context.lecturers
                  .map((lecturer) => `${lecturer.name} (${lecturer.staffId})`)
                  .join(", ")}
              </p>
              <p>
                <span className="app-detail__label">Completed sessions: </span>
                {context.totalCompletedSessions === 1
                  ? "1 session"
                  : `${context.totalCompletedSessions} sessions`}
              </p>
            </div>

            <hr className="admin-detail__divider" />

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
                <div className="admin-table-scroll">
                  <table className="admin-table">
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
                          <td>
                            <span className="admin-table__primary">
                              {student.studentName}
                            </span>
                          </td>
                          <td>{student.matricNumber}</td>
                          <td>{student.totalCompletedSessions}</td>
                          <td>{student.presentCount}</td>
                          <td>{student.lateCount}</td>
                          <td>{student.absentCount}</td>
                          <td>{formatPercentage(student.attendancePercentage)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}