import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  assignOfferingLecturer,
  createCourseOffering,
  listAdminCourses,
  listOfferingLecturers,
  removeOfferingLecturer,
} from "../api/adminCourses";
import { listAdminLecturers } from "../api/adminLecturers";
import { listAcademicSessions, listSemesters } from "../api/academicPeriods";
import { ApiError } from "../api/client";
import { listAdminCourseOfferings } from "../api/attendance";
import { FormError } from "../components/FormError";
import { statusLabel } from "../lib/format";
import type { AdminCourse, AdminAssignedLecturer } from "../types/adminCourse";
import type { AdminLecturer } from "../types/adminLecturer";
import type { AcademicSession, Semester } from "../types/academicPeriod";
import type { AdminCourseOffering, OfferingStatus } from "../types/attendance";

function offeringsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to view course offerings.";
    }
  }
  return "The course offerings could not be loaded. Please try again.";
}

function referenceDataErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to manage course offerings.";
    }
  }
  return "Courses, academic sessions, semesters, or lecturers could not be loaded. Please try again.";
}

function offeringCreateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to create course offerings.";
    }
    if (error.status === 400) {
      return "Check the offering details and try again.";
    }
    if (error.status === 404) {
      return "The selected course, academic session, or semester no longer exists. Please refresh and try again.";
    }
    if (error.status === 409) {
      if (error.code === "COURSE_NOT_ACTIVE") {
        return "An inactive course cannot receive a new offering.";
      }
      return "This course is already offered for the selected academic session and semester.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function assignLecturerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to assign lecturers.";
    }
    if (error.status === 400) {
      return "The selected user is not a lecturer.";
    }
    if (error.status === 404) {
      return "The selected lecturer could not be found. Please refresh and try again.";
    }
    if (error.status === 409) {
      if (error.code === "ALREADY_ASSIGNED") {
        return "This lecturer is already assigned to this offering.";
      }
      if (error.code === "LECTURER_NOT_ACTIVE") {
        return "This lecturer account is not active and cannot be assigned.";
      }
    }
  }
  return "The lecturer could not be assigned. Please try again later.";
}

function removeLecturerErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to remove lecturers.";
    }
    if (error.status === 404) {
      return "This lecturer is no longer assigned to this offering. The list has been refreshed.";
    }
  }
  return "The lecturer could not be removed. Please try again later.";
}

function offeringStatusClass(status: OfferingStatus): string {
  return status === "OPEN" ? "student-status--active" : "student-status--inactive";
}

function offeringsCountLabel(count: number): string {
  return count === 1 ? "1 offering" : `${count} offerings`;
}

export function AdminCourseOfferingsPage() {
  const [offerings, setOfferings] = useState<AdminCourseOffering[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [courses, setCourses] = useState<AdminCourse[]>([]);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [lecturers, setLecturers] = useState<AdminLecturer[]>([]);
  const [refError, setRefError] = useState<string | null>(null);
  const [refReloadKey, setRefReloadKey] = useState(0);

  const [createCourseId, setCreateCourseId] = useState("");
  const [createSessionId, setCreateSessionId] = useState("");
  const [createSemesterId, setCreateSemesterId] = useState("");
  const [createFieldError, setCreateFieldError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [expandedOfferingId, setExpandedOfferingId] = useState<number | null>(null);
  const [assigned, setAssigned] = useState<AdminAssignedLecturer[] | null>(null);
  const [assignedError, setAssignedError] = useState<string | null>(null);
  const [assignedReloadKey, setAssignedReloadKey] = useState(0);
  const [assignLecturerId, setAssignLecturerId] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  const [removeBusyLecturerId, setRemoveBusyLecturerId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAdminCourseOfferings()
      .then((result) => {
        if (!cancelled) {
          setOfferings(result.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(offeringsErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listAdminCourses(),
      listAcademicSessions(),
      listSemesters(),
      listAdminLecturers(),
    ])
      .then(([courseResult, sessionResult, semesterResult, lecturerResult]) => {
        if (cancelled) {
          return;
        }
        setCourses(courseResult.data);
        setSessions(sessionResult.data);
        setSemesters(semesterResult.data);
        setLecturers(lecturerResult.data);

        const activeSession = sessionResult.data.find((session) => session.isActive);
        if (activeSession !== undefined) {
          setCreateSessionId((current) =>
            current === "" ? String(activeSession.id) : current
          );
        }
        const firstSemester =
          semesterResult.data.find((semester) => semester.name === "First Semester") ??
          semesterResult.data[0];
        if (firstSemester !== undefined) {
          setCreateSemesterId((current) =>
            current === "" ? String(firstSemester.id) : current
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRefError(referenceDataErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refReloadKey]);

  useEffect(() => {
    if (expandedOfferingId === null) {
      setAssigned(null);
      setAssignedError(null);
      setAssignLecturerId("");
      setAssignSuccess(null);
      setAssignError(null);
      setRemoveError(null);
      return;
    }
    let cancelled = false;
    setAssigned(null);
    setAssignedError(null);
    setAssignLecturerId("");
    listOfferingLecturers(expandedOfferingId)
      .then((result) => {
        if (!cancelled) {
          setAssigned(result.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssignedError(assignLecturerErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expandedOfferingId, assignedReloadKey]);

  function refresh(): void {
    setOfferings(null);
    setListError(null);
    setReloadKey((key) => key + 1);
  }

  function refreshReferenceData(): void {
    setRefError(null);
    setRefReloadKey((key) => key + 1);
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) {
      return;
    }

    setCreateError(null);
    setCreateSuccess(null);
    if (createCourseId === "" || createSessionId === "" || createSemesterId === "") {
      setCreateFieldError(
        "Please select a course, academic session, and semester."
      );
      return;
    }
    setCreateFieldError(null);

    setIsCreating(true);
    try {
      await createCourseOffering({
        courseId: Number(createCourseId),
        academicSessionId: Number(createSessionId),
        semesterId: Number(createSemesterId),
      });
      setCreateCourseId("");
      setCreateSuccess("Course offering created.");
      refresh();
    } catch (error) {
      setCreateError(offeringCreateErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  function toggleLecturers(offeringId: number): void {
    setExpandedOfferingId((current) => (current === offeringId ? null : offeringId));
  }

  async function handleAssignSubmit(): Promise<void> {
    if (expandedOfferingId === null || isAssigning) {
      return;
    }
    if (assignLecturerId === "") {
      setAssignError("Please select a lecturer to assign.");
      return;
    }
    setAssignError(null);
    setAssignSuccess(null);
    setIsAssigning(true);
    try {
      await assignOfferingLecturer(expandedOfferingId, {
        lecturerId: Number(assignLecturerId),
      });
      setAssignLecturerId("");
      setAssignSuccess("Lecturer assigned.");
      setAssignedReloadKey((key) => key + 1);
    } catch (error) {
      setAssignError(assignLecturerErrorMessage(error));
    } finally {
      setIsAssigning(false);
    }
  }

  async function handleRemoveSubmit(lecturerId: number): Promise<void> {
    if (expandedOfferingId === null || removeBusyLecturerId !== null) {
      return;
    }
    setRemoveError(null);
    setAssignSuccess(null);
    setRemoveBusyLecturerId(lecturerId);
    try {
      await removeOfferingLecturer(expandedOfferingId, lecturerId);
      setAssignSuccess("Lecturer removed.");
      setAssignedReloadKey((key) => key + 1);
    } catch (error) {
      setRemoveError(removeLecturerErrorMessage(error));
    } finally {
      setRemoveBusyLecturerId(null);
    }
  }

  const loading = offerings === null && listError === null;
  const refLoading = refError === null;
  const total = offerings?.length ?? 0;

  const activeCourses = courses.filter((course) => course.status === "ACTIVE");
  const assignedIds = new Set((assigned ?? []).map((lecturer) => lecturer.id));
  const availableLecturers = lecturers.filter(
    (lecturer) => !assignedIds.has(lecturer.id)
  );

  // The assigned-lecturer rows carry only a department id, so resolve the name
  // from the lecturer list this page already loaded rather than showing a bare
  // number to the administrator.
  function departmentNameFor(departmentId: number): string {
    return (
      lecturers.find((lecturer) => lecturer.departmentId === departmentId)
        ?.departmentName ?? "Not available"
    );
  }

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Course offerings</h1>
          <p className="app-header__sub">
            Schedule a course for a session and semester, and assign its lecturers.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      {listError !== null ? (
        <div className="resource-error">
          <FormError message={listError} />
          <button type="button" className="secondary-button" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="inline-status" role="status">
          Loading course offerings…
        </p>
      ) : null}

      {offerings !== null && offerings.length === 0 ? (
        <div className="admin-empty">
          <p className="admin-empty__message" role="status">
            No course offerings found.
          </p>
          <p className="inline-status">
            Course offerings will appear here once they are created.
          </p>
        </div>
      ) : null}

      {offerings !== null && offerings.length > 0 ? (
        <>
          <p className="inline-status" role="status">
            {offeringsCountLabel(total)}
          </p>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Course</th>
                  <th scope="col">Academic Session</th>
                  <th scope="col">Semester</th>
                  <th scope="col">Level</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {offerings.map((offering) => (
                  <Fragment key={offering.id}>
                    <tr className="admin-table__row">
                      <td>
                        <span className="admin-table__primary">
                          {offering.courseCode}
                        </span>
                        <span className="admin-table__secondary">
                          {offering.courseTitle}
                        </span>
                      </td>
                      <td>{offering.academicSessionName}</td>
                      <td>{offering.semesterName}</td>
                      <td>Level {offering.levelName}</td>
                      <td>
                        <span
                          className={`student-status ${offeringStatusClass(offering.status)}`}
                        >
                          {statusLabel(offering.status)}
                        </span>
                      </td>
                      <td>
                        <div className="confirm-row">
                          <Link
                            to={`/app/admin/course-offerings/${offering.id}/roster`}
                            className="secondary-button"
                          >
                            View roster
                          </Link>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => toggleLecturers(offering.id)}
                            aria-expanded={expandedOfferingId === offering.id}
                          >
                            {expandedOfferingId === offering.id
                              ? "Close lecturers"
                              : "Lecturers"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedOfferingId === offering.id ? (
                      <tr>
                        <td colSpan={6}>
                          <section
                            className="app-card"
                            aria-label={`Lecturers for ${offering.courseCode}`}
                          >
                            <h3>Lecturers for {offering.courseCode}</h3>

                            {assigned === null && assignedError === null ? (
                              <p className="inline-status" role="status">
                                Loading lecturers…
                              </p>
                            ) : null}

                            {assignedError !== null ? (
                              <div className="resource-error">
                                <FormError message={assignedError} />
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={() =>
                                    setAssignedReloadKey((key) => key + 1)
                                  }
                                >
                                  Retry
                                </button>
                              </div>
                            ) : null}

                            {assigned !== null ? (
                              <>
                                {assigned.length === 0 ? (
                                  <div className="admin-empty">
                                    <p
                                      className="admin-empty__message"
                                      role="status"
                                    >
                                      No lecturers assigned yet.
                                    </p>
                                  </div>
                                ) : (
                                  <div className="admin-table-scroll">
                                    <table className="admin-table">
                                      <thead>
                                        <tr>
                                          <th scope="col">Lecturer</th>
                                          <th scope="col">Staff ID</th>
                                          <th scope="col">Department</th>
                                          <th scope="col">Actions</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {assigned.map((lecturer) => (
                                          <tr
                                            key={lecturer.id}
                                            className="admin-table__row"
                                          >
                                            <td>
                                              <span className="admin-table__primary">
                                                {lecturer.name}
                                              </span>
                                            </td>
                                            <td>
                                              <span className="admin-table__secondary">
                                                {lecturer.staffId}
                                              </span>
                                            </td>
                                            <td>
                                              {departmentNameFor(lecturer.departmentId)}
                                            </td>
                                            <td>
                                              <button
                                                type="button"
                                                className="danger-button"
                                                onClick={() =>
                                                  handleRemoveSubmit(lecturer.id)
                                                }
                                                disabled={
                                                  removeBusyLecturerId !== null ||
                                                  isAssigning
                                                }
                                                aria-busy={
                                                  removeBusyLecturerId ===
                                                  lecturer.id
                                                }
                                              >
                                                {removeBusyLecturerId === lecturer.id
                                                  ? "Removing…"
                                                  : "Remove"}
                                              </button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                <div className="admin-inline-form">
                                  <div className="field">
                                    <label
                                      htmlFor={`assign-lecturer-${offering.id}`}
                                      className="field__label"
                                    >
                                      Assign a lecturer
                                    </label>
                                    <select
                                      id={`assign-lecturer-${offering.id}`}
                                      className="field__input"
                                      value={assignLecturerId}
                                      onChange={(event) => {
                                        setAssignLecturerId(event.target.value);
                                        setAssignError(null);
                                        setAssignSuccess(null);
                                      }}
                                    >
                                      <option value="">Select a lecturer</option>
                                      {availableLecturers.map((lecturer) => (
                                        <option key={lecturer.id} value={lecturer.id}>
                                          {lecturer.name} ({lecturer.staffId}) ·{" "}
                                          {lecturer.departmentName}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <button
                                    type="button"
                                    className="auth-submit admin-submit"
                                    onClick={handleAssignSubmit}
                                    disabled={
                                      isAssigning ||
                                      assignLecturerId === "" ||
                                      removeBusyLecturerId !== null
                                    }
                                    aria-busy={isAssigning}
                                  >
                                    {isAssigning ? "Assigning…" : "Assign lecturer"}
                                  </button>
                                </div>

                                {availableLecturers.length === 0 ? (
                                  <p className="inline-status" role="status">
                                    Every active lecturer is already assigned.
                                  </p>
                                ) : null}

                                {assignError !== null ? (
                                  <div className="resource-error">
                                    <FormError message={assignError} />
                                  </div>
                                ) : null}
                                {removeError !== null ? (
                                  <div className="resource-error">
                                    <FormError message={removeError} />
                                  </div>
                                ) : null}
                                {assignSuccess !== null ? (
                                  <div className="resource-success" role="status">
                                    <p>{assignSuccess}</p>
                                  </div>
                                ) : null}
                              </>
                            ) : null}
                          </section>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <section
        className="app-card app-card--wide admin-compact-form-card"
        aria-labelledby="create-offering-heading"
      >
        <h2 id="create-offering-heading">Create course offering</h2>
        <p className="note">
          An offering schedules one active course for an academic session and
          semester. It starts open for student registration.
        </p>

        {refError !== null ? (
          <div className="resource-error">
            <FormError message={refError} />
            <button
              type="button"
              className="secondary-button"
              onClick={refreshReferenceData}
            >
              Retry
            </button>
          </div>
        ) : null}

        {refLoading && refError === null ? (
          <p className="inline-status" role="status">
            Loading reference data…
          </p>
        ) : null}

        <form className="admin-inline-form admin-compact-form admin-compact-form--offering" onSubmit={handleCreateSubmit} noValidate>
          <div className="field admin-inline-field">
            <label htmlFor="create-offering-course" className="field__label">
              Course
            </label>
            <select
              id="create-offering-course"
              className="field__input"
              value={createCourseId}
              onChange={(event) => {
                setCreateCourseId(event.target.value);
                setCreateFieldError(null);
                setCreateSuccess(null);
              }}
            >
              <option value="">Select a course</option>
              {activeCourses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.courseCode} · {course.title} (Level {course.levelName})
                </option>
              ))}
            </select>
          </div>
          <div className="field admin-inline-field">
            <label htmlFor="create-offering-session" className="field__label">
              Academic session
            </label>
            <select
              id="create-offering-session"
              className="field__input"
              value={createSessionId}
              onChange={(event) => {
                setCreateSessionId(event.target.value);
                setCreateFieldError(null);
                setCreateSuccess(null);
              }}
            >
              <option value="">Select an academic session</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}
                  {session.isActive ? " (active)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field admin-inline-field">
            <label htmlFor="create-offering-semester" className="field__label">
              Semester
            </label>
            <select
              id="create-offering-semester"
              className="field__input"
              value={createSemesterId}
              onChange={(event) => {
                setCreateSemesterId(event.target.value);
                setCreateFieldError(null);
                setCreateSuccess(null);
              }}
            >
              <option value="">Select a semester</option>
              {semesters.map((semester) => (
                <option key={semester.id} value={semester.id}>
                  {semester.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="auth-submit admin-submit"
            disabled={isCreating}
            aria-busy={isCreating}
          >
            {isCreating ? "Creating…" : "Create offering"}
          </button>
        </form>
        {createFieldError !== null ? (
          <div className="resource-error">
            <FormError message={createFieldError} />
          </div>
        ) : null}
        {createError !== null ? (
          <div className="resource-error">
            <FormError message={createError} />
          </div>
        ) : null}
        {createSuccess !== null ? (
          <div className="resource-success" role="status">
            <p>{createSuccess}</p>
          </div>
        ) : null}
      </section>
    </main>
  );
}