import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  getAdminStudent,
  listAdminStudents,
  resetStudentRegistration,
  updateStudentStatus,
} from "../api/adminStudents";
import { listAdminDepartments } from "../api/adminOrganization";
import type { AdminDepartment } from "../types/adminOrganization";
import type {
  AdminStudentDetail,
  AdminStudentListItem,
  AdminStudentStatus,
} from "../types/studentAdmin";
import { FormError } from "../components/FormError";
import { ADMIN_LEVEL_OPTIONS } from "../lib/adminLevels";
import { countLabel as formatCount, statusLabel } from "../lib/format";

const STATUS_OPTIONS: readonly AdminStudentStatus[] = [
  "ACTIVE",
  "INACTIVE",
  "PENDING",
];

const STUDENT_STATUS_LABELS: Record<AdminStudentStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  PENDING: "Pending",
};

interface StudentFilters {
  matricNumber: string;
  name: string;
  departmentId: string;
  levelId: string;
  status: string;
}

interface ConfirmState {
  kind: "DEACTIVATE" | "REACTIVATE" | "RESET";
  student: AdminStudentListItem;
}

function emptyFilters(): StudentFilters {
  return {
    matricNumber: "",
    name: "",
    departmentId: "",
    levelId: "",
    status: "",
  };
}

function adminStudentListErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You do not have permission to view students.";
  }
  return "Something went wrong. Please try again later.";
}

function catalogErrorMessage(): string {
  return "Some filter options could not be loaded. The list still works without them.";
}

function statusChangeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to change student status.";
    }
    if (error.status === 404) {
      return "The student was not found.";
    }
    if (error.status === 409 && error.code === "ACTIVE_REQUIRES_PASSWORD") {
      return "This account has no password and cannot be activated. The student must complete registration before signing in.";
    }
    if (error.status === 409 && error.code === "NO_OP_CORRECTION") {
      return "This student already has this status; no change was made.";
    }
    if (error.status === 409) {
      return "The student could not be updated because their status changed. Please try again.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function resetErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to reset student registration.";
    }
    if (error.status === 404) {
      return "The student was not found.";
    }
    if (error.status === 409 && error.code === "ALREADY_PENDING") {
      return "This student is already pending registration.";
    }
    if (error.status === 409 && error.code === "INVALID_STUDENT_STATE") {
      return "Only active students can have their registration reset.";
    }
    if (error.status === 409) {
      return "The student could not be reset because their state changed. Please refresh and try again.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function detailErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to view student details.";
    }
    if (error.status === 404) {
      return "The student was not found.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function studentStatusClass(status: AdminStudentStatus): string {
  switch (status) {
    case "ACTIVE":
      return "student-status--active";
    case "INACTIVE":
      return "student-status--inactive";
    case "PENDING":
      return "student-status--pending";
  }
}

function deviceLabel(device: AdminStudentDetail["device"]): string {
  if (device === null || device === undefined) {
    return "No device";
  }
  return statusLabel(device.status);
}

function statusActionLabel(student: AdminStudentListItem): string | null {
  switch (student.status) {
    case "ACTIVE":
      return "Deactivate";
    case "INACTIVE":
      return "Reactivate";
    case "PENDING":
      return null;
  }
}

export function AdminStudentsPage() {
  const [filters, setFilters] = useState<StudentFilters>(emptyFilters);
  const [students, setStudents] = useState<AdminStudentListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [departments, setDepartments] = useState<AdminDepartment[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const [detail, setDetail] = useState<AdminStudentDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  const [confirmAction, setConfirmAction] = useState<ConfirmState | null>(null);
  const [busyStudentId, setBusyStudentId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const matricFilterId = useId();
  const nameFilterId = useId();
  const departmentFilterId = useId();
  const levelFilterId = useId();
  const statusFilterId = useId();

  useEffect(() => {
    let cancelled = false;
    setCatalogError(null);
    listAdminDepartments()
      .then((result) => {
        if (!cancelled) {
          setDepartments(result.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError(catalogErrorMessage());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogReloadKey]);

  useEffect(() => {
    let cancelled = false;
    setStudents(null);
    setListError(null);
    setOpenDetail(null);
    setDetail(null);
    setDetailError(null);

    listAdminStudents({
      matricNumber: filters.matricNumber || undefined,
      name: filters.name || undefined,
      departmentId: filters.departmentId ? Number(filters.departmentId) : undefined,
      levelId: filters.levelId ? Number(filters.levelId) : undefined,
      status: (filters.status as AdminStudentStatus | undefined) || undefined,
    })
      .then((result) => {
        if (!cancelled) {
          setStudents(result.data.items);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(adminStudentListErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, filters]);

  useEffect(() => {
    if (openDetail === null) {
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    getAdminStudent(openDetail)
      .then((result) => {
        if (!cancelled) {
          setDetail(result.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(detailErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [openDetail, detailReloadKey]);

  function refresh(): void {
    setActionSuccess(null);
    setActionError(null);
    setReloadKey((key) => key + 1);
  }

  function clearFilters(): void {
    setFilters(emptyFilters());
  }

  function handleStatusClick(
    kind: "DEACTIVATE" | "REACTIVATE",
    student: AdminStudentListItem
  ): void {
    setConfirmAction({ kind, student });
    setActionError(null);
    setActionSuccess(null);
  }

  function handleResetClick(student: AdminStudentListItem): void {
    setConfirmAction({ kind: "RESET", student });
    setActionError(null);
    setActionSuccess(null);
  }

  function cancelAction(): void {
    setConfirmAction(null);
    setActionError(null);
    setActionSuccess(null);
  }

  async function handleConfirm(): Promise<void> {
    if (confirmAction === null) {
      return;
    }
    const { kind, student } = confirmAction;
    setBusyStudentId(student.studentId);
    setActionError(null);
    setActionSuccess(null);

    try {
      if (kind === "RESET") {
        await resetStudentRegistration(student.studentId);
        setActionSuccess(
          "Registration reset. The student is now pending and must complete registration again."
        );
      } else {
        const targetStatus = kind === "DEACTIVATE" ? "INACTIVE" : "ACTIVE";
        await updateStudentStatus(student.studentId, targetStatus);
        setActionSuccess(
          targetStatus === "INACTIVE"
            ? "The student has been deactivated and can no longer sign in."
            : "The student has been reactivated and can sign in again."
        );
      }
      setConfirmAction(null);
      setDetail(null);
      setReloadKey((key) => key + 1);
      if (openDetail === student.studentId) {
        setDetailReloadKey((key) => key + 1);
      }
    } catch (error) {
      setActionError(kind === "RESET" ? resetErrorMessage(error) : statusChangeErrorMessage(error));
    } finally {
      setBusyStudentId(null);
    }
  }

  const loading = students === null && listError === null;
  const total = students?.length ?? 0;

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Student management</h1>
          <p className="app-header__sub">
            Student accounts, their status, and their enrolled devices.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="filters-heading">
        <h2 id="filters-heading">Filters</h2>
        {catalogError !== null ? (
          <div className="resource-error">
            <FormError message={catalogError} />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCatalogReloadKey((key) => key + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}
        <div className="admin-filter-grid">
          <div className="field">
            <label htmlFor={matricFilterId} className="field__label">
              Matric Number
            </label>
            <input
              id={matricFilterId}
              className="field__input"
              type="text"
              placeholder="Filter by matric number"
              value={filters.matricNumber}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  matricNumber: event.target.value,
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor={nameFilterId} className="field__label">
              Student Name
            </label>
            <input
              id={nameFilterId}
              className="field__input"
              type="text"
              placeholder="Filter by student name"
              value={filters.name}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor={departmentFilterId} className="field__label">
              Department
            </label>
            <select
              id={departmentFilterId}
              className="field__input"
              value={filters.departmentId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  departmentId: event.target.value,
                }))
              }
            >
              <option value="">All departments</option>
              {(departments ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name} ({department.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={levelFilterId} className="field__label">
              Level
            </label>
            <select
              id={levelFilterId}
              className="field__input"
              value={filters.levelId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  levelId: event.target.value,
                }))
              }
            >
              <option value="">All levels</option>
              {ADMIN_LEVEL_OPTIONS.map((level) => (
                <option key={level.id} value={level.id}>
                  Level {level.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={statusFilterId} className="field__label">
              Status
            </label>
            <select
              id={statusFilterId}
              className="field__input"
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {STUDENT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="confirm-row">
          <button type="button" className="secondary-button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </section>

      <section className="app-card app-card--wide" aria-labelledby="students-heading">
        <h2 id="students-heading">Students</h2>

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
            Loading students…
          </p>
        ) : null}

        {students !== null && students.length === 0 ? (
          <div className="admin-empty">
            <p className="admin-empty__message" role="status">
              No students match the current filters.
            </p>
            <p className="inline-status">Try adjusting the filters, or clear them.</p>
          </div>
        ) : null}

        {students !== null && students.length > 0 ? (
          <>
            <p className="inline-status" role="status">
              {formatCount(total, "student", "students")}
            </p>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Matric Number</th>
                    <th scope="col">Department</th>
                    <th scope="col">Level</th>
                    <th scope="col">Status</th>
                    <th scope="col">Enrolled Courses</th>
                    <th scope="col">Device</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.studentId} className="admin-table__row">
                      <td>
                        <span className="admin-table__primary">{student.name}</span>
                      </td>
                      <td>
                        <span className="admin-table__secondary">
                          {student.matricNumber}
                        </span>
                      </td>
                      <td>
                        <span className="admin-table__primary">
                          {student.department.name}
                        </span>
                        <span className="admin-table__secondary">
                          {student.department.code}
                        </span>
                      </td>
                      <td>Level {student.level.name}</td>
                      <td>
                        <span
                          className={`student-status ${studentStatusClass(student.status)}`}
                        >
                          {STUDENT_STATUS_LABELS[student.status]}
                        </span>
                      </td>
                      <td>
                        {formatCount(
                          student.registeredCourseCount,
                          "course",
                          "courses"
                        )}
                      </td>
                      <td>
                        <span
                          className={
                            student.hasActiveDevice
                              ? "student-status student-status--active"
                              : "student-status student-status--none"
                          }
                        >
                          {student.hasActiveDevice ? "Active" : "No device"}
                        </span>
                      </td>
                      <td>
                        <div className="confirm-row">
                          <button
                            type="button"
                            className="secondary-button admin-table__view"
                            onClick={() => {
                              setOpenDetail(student.studentId);
                              setConfirmAction(null);
                              setActionError(null);
                              setActionSuccess(null);
                            }}
                          >
                            View details
                          </button>
                          {statusActionLabel(student) !== null ? (
                            <button
                              type="button"
                              className={`secondary-button ${
                                student.status === "ACTIVE" ? "danger-button" : ""
                              }`}
                              onClick={() =>
                                handleStatusClick(
                                  student.status === "ACTIVE"
                                    ? "DEACTIVATE"
                                    : "REACTIVATE",
                                  student
                                )
                              }
                              disabled={busyStudentId !== null}
                            >
                              {statusActionLabel(student)}
                            </button>
                          ) : null}
                          {student.status === "ACTIVE" ? (
                            <button
                              type="button"
                              className="secondary-button danger-button"
                              onClick={() => handleResetClick(student)}
                              disabled={busyStudentId !== null}
                            >
                              Reset registration
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {confirmAction !== null ? (
          <div className="confirm-row confirm-row--block">
            {confirmAction.kind === "RESET" ? (
              <>
                <p className="confirm-message">
                  Reset registration for {confirmAction.student.name}? This will:
                </p>
                <ul className="confirm-message__list">
                  <li>return their account to Pending registration,</li>
                  <li>clear their password so they cannot sign in,</li>
                  <li>require them to complete student registration again,</li>
                  <li>keep their enrolled-course history intact, and</li>
                  <li>retain their existing active device for now.</li>
                </ul>
              </>
            ) : confirmAction.kind === "DEACTIVATE" ? (
              <p className="confirm-message">
                Deactivate {confirmAction.student.name}? They will no longer be
                able to sign in until the account is reactivated. Their course
                history and attendance records are kept.
              </p>
            ) : (
              <p className="confirm-message">
                Reactivate {confirmAction.student.name}? They will be able to
                sign in again.
              </p>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                className="danger-button"
                onClick={handleConfirm}
                disabled={busyStudentId !== null}
                aria-busy={busyStudentId !== null}
              >
                {busyStudentId === confirmAction.student.studentId
                  ? "Confirming…"
                  : confirmAction.kind === "RESET"
                    ? "Confirm reset"
                    : confirmAction.kind === "DEACTIVATE"
                      ? "Confirm deactivate"
                      : "Confirm reactivate"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={cancelAction}
                disabled={busyStudentId !== null}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {actionError !== null ? (
          <div className="resource-error">
            <FormError message={actionError} />
          </div>
        ) : null}

        {actionSuccess !== null ? (
          <div className="resource-success" role="status">
            <p>{actionSuccess}</p>
          </div>
        ) : null}
      </section>

      {openDetail !== null ? (
        <section
          className="app-card app-card--wide"
          aria-labelledby="student-details-heading"
        >
          <div className="admin-detail__header">
            <h2 id="student-details-heading">Student details</h2>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setOpenDetail(null)}
            >
              Close details
            </button>
          </div>

          {detailError !== null ? (
            <div className="resource-error">
              <FormError message={detailError} />
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDetailReloadKey((key) => key + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}

          {detail === null && detailError === null ? (
            <p className="inline-status" role="status">
              Loading student details…
            </p>
          ) : null}

          {detail !== null ? (
            <div className="admin-detail">
              <p>
                <strong>Name:</strong> {detail.name}
              </p>
              <p>
                <strong>Matric Number:</strong> {detail.matricNumber}
              </p>
              <p>
                <strong>Faculty:</strong> {detail.faculty.name} ({detail.faculty.code})
              </p>
              <p>
                <strong>Department:</strong> {detail.department.name} ({detail.department.code})
              </p>
              <p>
                <strong>Level:</strong> Level {detail.level.name}
              </p>
              <p>
                <strong>Status:</strong>{" "}
                <span className={`student-status ${studentStatusClass(detail.status)}`}>
                  {STUDENT_STATUS_LABELS[detail.status]}
                </span>
              </p>
              <p>
                <strong>Enrolled Courses:</strong>{" "}
                {formatCount(detail.registeredCourseCount, "course", "courses")}
              </p>
              <p>
                <strong>Created:</strong> {formatDateTime(detail.createdAt)}
              </p>
              <p>
                <strong>Device:</strong>{" "}
                {detail.device === null ? (
                  "No device"
                ) : (
                  <>
                    {deviceLabel(detail.device)} ·{" "}
                    {formatCount(1, "device", "devices")} · Last seen{" "}
                    {detail.device.lastSeenAt
                      ? formatDateTime(detail.device.lastSeenAt)
                      : "never"}
                  </>
                )}
              </p>
              {detail.device !== null ? (
                <div className="device-details">
                  <h3 className="device-details__label">Device</h3>
                  <dl className="device-details__grid">
                    <dt>Label</dt>
                    <dd>{detail.device.label ?? "Unlabeled"}</dd>
                    <dt>Status</dt>
                    <dd>{deviceLabel(detail.device)}</dd>
                    <dt>Enrolled</dt>
                    <dd>{formatDateTime(detail.device.enrolledAt)}</dd>
                    {detail.device.lastSeenAt !== null ? (
                      <>
                        <dt>Last Seen</dt>
                        <dd>{formatDateTime(detail.device.lastSeenAt)}</dd>
                      </>
                    ) : null}
                    {detail.device.revokedAt !== null ? (
                      <>
                        <dt>Revoked</dt>
                        <dd>{formatDateTime(detail.device.revokedAt)}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}