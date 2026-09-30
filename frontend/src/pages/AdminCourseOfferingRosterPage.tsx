import { useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  enrollStudent,
  listCourseOfferingRegistrations,
} from "../api/adminCourseEnrollment";
import { listAdminStudents } from "../api/adminStudents";
import { FormError } from "../components/FormError";
import type {
  AdminCourseOfferingRegistrations,
  AdminCourseOfferingRegistrationsFilters,
  RegistrationStatus,
} from "../types/adminCourseEnrollment";
import type { AdminStudentListData } from "../types/studentAdmin";

const PAGE_SIZE = 10;

function parseOfferingId(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function AdminCourseOfferingRosterPage() {
  const { id } = useParams();
  const offeringId = parseOfferingId(id);
  const matricFilterId = useId();
  const nameFilterId = useId();
  const statusFilterId = useId();

  const [registrations, setRegistrations] = useState<AdminCourseOfferingRegistrations | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listReloadKey, setListReloadKey] = useState(0);
  const [offset, setOffset] = useState(0);

  const [filters, setFilters] = useState<AdminCourseOfferingRegistrationsFilters>({});

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollStudentId, setEnrollStudentId] = useState("");
  const [enrollStudentName, setEnrollStudentName] = useState("");
  const [enrollStudentMatric, setEnrollStudentMatric] = useState("");
  const [enrollStudentDept, setEnrollStudentDept] = useState("");
  const [enrollStudentLevel, setEnrollStudentLevel] = useState("");
  const [enrollSearchResults, setEnrollSearchResults] = useState<AdminStudentListData | null>(null);
  const [enrollSearchLoading, setEnrollSearchLoading] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollSuccess, setEnrollSuccess] = useState(false);

  const searchRequestRef = useRef(0);

  useEffect(() => {
    if (offeringId === null) {
      setRegistrations(null);
      setListError(null);
      return;
    }
    let cancelled = false;
    setRegistrations(null);
    setListError(null);
    const params: AdminCourseOfferingRegistrationsFilters = {
      limit: PAGE_SIZE,
      offset,
    };
    if (filters.status) params.status = filters.status;
    if (filters.matricNumber) params.matricNumber = filters.matricNumber;
    if (filters.studentName) params.studentName = filters.studentName;
    listCourseOfferingRegistrations(offeringId, params)
      .then((res) => {
        if (!cancelled) {
          setRegistrations(res.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(listErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [offeringId, listReloadKey, filters.status, filters.matricNumber, filters.studentName, offset]);

  function refreshRoster(): void {
    setOffset(0);
    setListReloadKey((key) => key + 1);
  }

  function clearFilters(): void {
    setFilters({});
  }

  async function handleEnrollSearch(query: string): Promise<void> {
    const requestId = ++searchRequestRef.current;
    setEnrollSearchLoading(true);
    setEnrollSearchResults(null);
    const trimmed = query.trim();
    try {
      if (trimmed === "") {
        if (searchRequestRef.current !== requestId) return;
        setEnrollSearchResults({ items: [], total: 0 });
        return;
      }
      const [byName, byMatric] = await Promise.all([
        listAdminStudents({ name: trimmed }),
        listAdminStudents({ matricNumber: trimmed }),
      ]);
      if (searchRequestRef.current !== requestId) return;
      const seen = new Set<number>();
      const items = [...byName.data.items, ...byMatric.data.items].filter((student) => {
        if (seen.has(student.studentId)) return false;
        seen.add(student.studentId);
        return true;
      });
      setEnrollSearchResults({ items, total: items.length });
    } catch {
      if (searchRequestRef.current !== requestId) return;
      setEnrollSearchResults(null);
    } finally {
      if (searchRequestRef.current === requestId) setEnrollSearchLoading(false);
    }
  }

  function selectEnrollStudent(student: { studentId: number; name: string; matricNumber: string; department: { name: string }; level: { name: number } }): void {
    setEnrollStudentId(String(student.studentId));
    setEnrollStudentName(student.name);
    setEnrollStudentMatric(student.matricNumber);
    setEnrollStudentDept(student.department.name);
    setEnrollStudentLevel(String(student.level.name));
    setEnrollSearchResults(null);
    setEnrollError(null);
    setEnrollSuccess(false);
  }

  async function handleEnrollSubmit(): Promise<void> {
    if (offeringId === null || enrollStudentId === "") return;
    setEnrollBusy(true);
    setEnrollError(null);
    setEnrollSuccess(false);
    try {
      await enrollStudent(offeringId, { studentId: Number(enrollStudentId) });
      setEnrollSuccess(true);
      setEnrollStudentId("");
      setEnrollStudentName("");
      setEnrollStudentMatric("");
      setEnrollStudentDept("");
      setEnrollStudentLevel("");
      refreshRoster();
    } catch (error: unknown) {
      setEnrollError(enrollErrorMessage(error));
    } finally {
      setEnrollBusy(false);
    }
  }

  const statusLabels: Record<RegistrationStatus, string> = {
    ENROLLED: "Enrolled",
    DROPPED: "Dropped",
    COMPLETED: "Completed",
  };

  const loading = offeringId !== null && registrations === null && listError === null;

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Course Offering Roster</h1>
          <p className="app-header__sub">
            View the roster for a course offering and enroll students.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      {offeringId === null ? (
        <section className="app-card app-card--wide">
          <FormError message="The course offering in this address is not valid." />
        </section>
      ) : null}

      {loading ? (
        <p className="inline-status" role="status">Loading roster…</p>
      ) : null}

      {listError !== null ? (
        <div className="resource-error">
          <FormError message={listError} />
          <button type="button" className="secondary-button" onClick={refreshRoster}>
            Retry
          </button>
        </div>
      ) : null}

      {registrations !== null ? (
        <>
          <section className="app-card app-card--wide" aria-labelledby="roster-offering-title">
            <h2 id="roster-offering-title">Offering</h2>
            <div className="admin-detail">
              <p>
                <strong>Course:</strong> {registrations.courseOffering.courseCode} — {registrations.courseOffering.courseTitle}
              </p>
              <p>
                <strong>Academic session:</strong> {registrations.courseOffering.academicSession}
              </p>
              <p>
                <strong>Semester:</strong> {registrations.courseOffering.semester}
              </p>
              <p>
                <strong>Level:</strong> Level {registrations.courseOffering.level.name}
              </p>
              <p>
                <strong>Status:</strong> {registrations.courseOffering.status}
              </p>
            </div>
          </section>

          <section className="app-card app-card--wide" aria-labelledby="roster-filters-title">
            <h2 id="roster-filters-title">Filters</h2>
            <div className="admin-filter-grid">
              <div className="field">
                <label htmlFor={matricFilterId} className="field__label">Matric number</label>
                <input id={matricFilterId} className="field__input" type="text" placeholder="Filter by matric" value={filters.matricNumber ?? ""} onChange={(event) => setFilters((f) => ({ ...f, matricNumber: event.target.value || undefined }))} />
              </div>
              <div className="field">
                <label htmlFor={nameFilterId} className="field__label">Student name</label>
                <input id={nameFilterId} className="field__input" type="text" placeholder="Filter by name" value={filters.studentName ?? ""} onChange={(event) => setFilters((f) => ({ ...f, studentName: event.target.value || undefined }))} />
              </div>
              <div className="field">
                <label htmlFor={statusFilterId} className="field__label">Status</label>
                <select id={statusFilterId} className="field__input" value={filters.status ?? ""} onChange={(event) => setFilters((f) => ({ ...f, status: (event.target.value || undefined) as RegistrationStatus | undefined }))}>
                  <option value="">All statuses</option>
                  <option value="ENROLLED">Enrolled</option>
                  <option value="DROPPED">Dropped</option>
                  <option value="COMPLETED">Completed</option>
                </select>
              </div>
            </div>
            <div className="confirm-row">
              <button type="button" className="secondary-button" onClick={clearFilters}>Clear filters</button>
            </div>
          </section>

          <div className="confirm-row">
            <button type="button" className="auth-submit admin-submit" onClick={() => { setEnrollError(null); setEnrollSuccess(false); setEnrollOpen(true); }} disabled={enrollBusy}>
              Enroll Student
            </button>
          </div>

          {registrations.items.length === 0 ? (
            <div className="admin-empty">
              <p className="form-error admin-empty__message" role="status">No registrations match the current filters.</p>
              <p className="inline-status">Try adjusting the filters, or enroll a student.</p>
            </div>
          ) : (
            <>
              <p className="inline-status" role="status">{registrations.total} registration(s)</p>
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Student</th>
                      <th scope="col">Matric Number</th>
                      <th scope="col">Department</th>
                      <th scope="col">Level</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registrations.items.map((item) => (
                      <tr key={item.registrationId} className="admin-table__row">
                        <td><span className="admin-table__primary">{item.studentName}</span></td>
                        <td><span className="admin-table__secondary">{item.matricNumber}</span></td>
                        <td>{item.department.name}</td>
                        <td>Level {item.level.name}</td>
                        <td>{statusLabels[item.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="confirm-row">
                <button type="button" className="secondary-button" onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0}>Previous</button>
                <button type="button" className="secondary-button" onClick={() => setOffset((o) => o + PAGE_SIZE)} disabled={registrations.items.length < PAGE_SIZE}>Next</button>
              </div>
            </>
          )}

          {enrollOpen ? (
            <div className="confirm-row confirm-row--block">
              <p className="confirm-message">Enroll a student by searching for their name or matric number.</p>
              <div className="admin-inline-form">
                <div className="field">
                  <label htmlFor="enroll-search" className="field__label">Search students</label>
                  <input id="enroll-search" className="field__input" type="text" placeholder="Name or matric number" value={enrollStudentName} onChange={(event) => { setEnrollStudentName(event.target.value); handleEnrollSearch(event.target.value); }} />
                </div>
              </div>
              {enrollSearchLoading ? (
                <p className="inline-status" role="status">Searching…</p>
              ) : enrollSearchResults !== null ? (
                <div className="admin-table-scroll">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Matric</th>
                        <th scope="col">Department</th>
                        <th scope="col">Level</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrollSearchResults.items.map((student) => (
                        <tr key={student.studentId} className="admin-table__row">
                          <td>{student.name}</td>
                          <td>{student.matricNumber}</td>
                          <td>{student.department.name}</td>
                          <td>Level {student.level.name}</td>
                          <td><button type="button" className="secondary-button" onClick={() => selectEnrollStudent(student)}>Select</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="inline-status" role="status">No students found.</p>
              )}

              {enrollStudentId !== "" ? (
                <div className="admin-detail">
                  <p><strong>Name:</strong> {enrollStudentName}</p>
                  <p><strong>Matric:</strong> {enrollStudentMatric}</p>
                  <p><strong>Department:</strong> {enrollStudentDept}</p>
                  <p><strong>Level:</strong> Level {enrollStudentLevel}</p>
                </div>
              ) : null}

              {enrollError !== null ? (
                <div className="resource-error"><FormError message={enrollError} /></div>
              ) : null}
              {enrollSuccess ? (
                <div className="resource-success" role="status"><p>Student enrolled successfully.</p></div>
              ) : null}

              <div className="confirm-actions">
                <button type="button" className="danger-button" onClick={handleEnrollSubmit} disabled={enrollBusy || enrollStudentId === ""} aria-busy={enrollBusy}>
                  {enrollBusy ? "Enrolling…" : "Confirm Enrollment"}
                </button>
                <button type="button" className="secondary-button" onClick={() => { setEnrollOpen(false); setEnrollError(null); setEnrollSuccess(false); }} disabled={enrollBusy}>Cancel</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) return "You do not have permission to view this roster.";
    if (error.status === 404) return "The course offering could not be found.";
  }
  return "Something went wrong. Please try again later.";
}

function enrollErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) return "You do not have permission to enroll students.";
    if (error.status === 404) return "The student or course offering was not found.";
    if (error.status === 409) {
      switch (error.code) {
        case "ALREADY_ENROLLED":
          return "This student is already enrolled in this offering.";
        case "ALREADY_DROPPED":
          return "This student has a dropped registration and cannot be re-enrolled.";
        case "ALREADY_COMPLETED":
          return "This student has a completed registration and cannot be re-enrolled.";
        case "STUDENT_NOT_ACTIVE":
          return "This student account is not active and cannot be enrolled.";
        case "STUDENT_WRONG_LEVEL":
          return "This student's level does not match the course level.";
        case "STUDENT_WRONG_FACULTY":
          return "This student's faculty does not match the course faculty.";
        case "STUDENT_WRONG_DEPARTMENT":
          return "This student's department does not match the course department.";
        case "OFFERING_NOT_OPEN":
          return "This offering is not open for enrollment.";
        case "NO_ACTIVE_ACADEMIC_SESSION":
          return "The offering's academic session is not active.";
        default:
          return "A registration conflict occurred. Refreshing the roster may help.";
      }
    }
  }
  return "Unable to reach the server. Check your connection and try again.";
}