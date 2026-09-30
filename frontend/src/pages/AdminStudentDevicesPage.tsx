import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  listAdminStudentDevices,
  resetStudentDevice,
} from "../api/adminStudentDevices";
import type {
  AdminStudentDeviceSummary,
  DeviceStatus,
} from "../types/adminStudentDevice";
import { FormError } from "../components/FormError";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function deviceListErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You do not have permission to view student devices.";
  }
  return "Something went wrong. Please try again later.";
}

function getSafeCredentialLabel(credentialId: string): string {
  if (credentialId.length <= 16) {
    return credentialId;
  }
  return `${credentialId.slice(0, 8)}…${credentialId.slice(-8)}`;
}

export function AdminStudentDevicesPage() {
  const [devices, setDevices] = useState<AdminStudentDeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [matricFilter, setMatricFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<DeviceStatus | "">("");

  const [busyStudentId, setBusyStudentId] = useState<number | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<number | null>(null);

  const matricFilterId = useId();
  const nameFilterId = useId();
  const statusFilterId = useId();

  useEffect(() => {
    let cancelled = false;
    listAdminStudentDevices({
      matricNumber: matricFilter || undefined,
      studentName: nameFilter || undefined,
      status: statusFilter || undefined,
    })
      .then((result) => {
        if (!cancelled) {
          setDevices(result.data);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(deviceListErrorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, matricFilter, nameFilter, statusFilter]);

  function resetErrorMessage(error: unknown): string {
    if (error instanceof ApiError && error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error instanceof ApiError && error.status === 403) {
      return "You do not have permission to reset student devices.";
    }
    if (error instanceof ApiError && error.status === 404) {
      return "The student was not found.";
    }
    if (error instanceof ApiError && error.status === 409) {
      if (error.code === "NO_ACTIVE_DEVICE") {
        return "The student does not have an active device to reset.";
      }
      if (error.code === "CONFLICT") {
        return "The device could not be reset due to a concurrent change. Please try again.";
      }
    }
    return "Something went wrong. Please try again later.";
  }

  function refresh(): void {
    setDevices(null);
    setError(null);
    setReloadKey((key) => key + 1);
  }

  function handleResetClick(student: AdminStudentDeviceSummary) {
    if (!student.hasActiveDevice || !student.device) return;
    setConfirmResetId(student.studentId);
    setResetError(null);
    setResetSuccess(null);
  }

  function cancelReset() {
    setConfirmResetId(null);
    setResetError(null);
    setResetSuccess(null);
  }

  async function handleConfirmReset(studentId: number) {
    setBusyStudentId(studentId);
    setResetError(null);
    try {
      await resetStudentDevice(studentId);
      setResetSuccess("Device has been revoked. The student must enroll a new device.");
      setConfirmResetId(null);
      refresh();
    } catch (err) {
      setResetError(resetErrorMessage(err));
    } finally {
      setBusyStudentId(null);
    }
  }

  const loading = devices === null && error === null;

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Student Device Administration</h1>
          <p className="app-header__sub">
            Manage WebAuthn device enrollments. Reset a device to revoke it and
            require the student to enroll a replacement.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="filters-heading">
        <h2 id="filters-heading">Filters</h2>
        <div className="admin-filters">
          <div className="field">
            <label htmlFor={matricFilterId} className="field__label">
              Matric Number
            </label>
            <input
              id={matricFilterId}
              className="field__input"
              type="text"
              placeholder="Filter by matric number"
              value={matricFilter}
              onChange={(e) => setMatricFilter(e.target.value)}
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
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={statusFilterId} className="field__label">
              Device Status
            </label>
            <select
              id={statusFilterId}
              className="field__input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DeviceStatus | "")}
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="REVOKED">Revoked</option>
              <option value="NO_DEVICE">No Device</option>
            </select>
          </div>
        </div>
      </section>

      <section className="app-card app-card--wide" aria-labelledby="devices-heading">
        <h2 id="devices-heading">Student Devices</h2>

        {error !== null ? (
          <div className="resource-error">
            <FormError message={error} />
            <button type="button" className="secondary-button" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <p className="inline-status" role="status">
            Loading student devices…
          </p>
        ) : null}

        {devices !== null && devices.length === 0 ? (
          <div className="admin-empty">
            <p className="form-error admin-empty__message" role="status">
              No students match the current filters.
            </p>
          </div>
        ) : null}

        {devices !== null && devices.length > 0 ? (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Student</th>
                  <th scope="col">Matric Number</th>
                  <th scope="col">Device Status</th>
                  <th scope="col">Enrolled</th>
                  <th scope="col">Revoked</th>
                  <th scope="col">Credential ID</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((student) => (
                  <tr key={student.studentId} className="admin-table__row">
                    <td className="admin-table__primary">{student.studentName}</td>
                    <td>{student.matricNumber}</td>
                    <td>
                      {student.hasActiveDevice && student.device ? (
                        <span className="device-status device-status--active">
                          Active
                        </span>
                      ) : student.device && student.device.status === "REVOKED" ? (
                        <span className="device-status device-status--revoked">
                          Revoked
                        </span>
                      ) : (
                        <span className="device-status device-status--none">
                          No Device
                        </span>
                      )}
                    </td>
                    <td>
                      {student.device
                        ? formatDateTime(student.device.enrolledAt)
                        : "—"}
                    </td>
                    <td>
                      {student.device?.revokedAt
                        ? formatDateTime(student.device.revokedAt)
                        : "—"}
                    </td>
                    <td>
                      {student.device ? (
                        <code className="credential-id">
                          {getSafeCredentialLabel(student.device.credentialId)}
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {student.hasActiveDevice && student.device ? (
                        <>
                          {confirmResetId === student.studentId ? (
                            <div className="confirm-row">
                              <p className="confirm-message">
                                This will revoke the student's active device. They
                                will need to enroll a new device before they can mark
                                attendance. The old device will no longer work.
                              </p>
                              <div className="confirm-actions">
                                <button
                                  type="button"
                                  className="danger-button"
                                  onClick={() => handleConfirmReset(student.studentId)}
                                  disabled={busyStudentId === student.studentId}
                                  aria-busy={busyStudentId === student.studentId}
                                >
                                  {busyStudentId === student.studentId
                                    ? "Revoking…"
                                    : "Confirm Reset"}
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={cancelReset}
                                  disabled={busyStudentId === student.studentId}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="secondary-button danger-button"
                              onClick={() => handleResetClick(student)}
                              disabled={busyStudentId !== null}
                            >
                              Reset Device
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="admin-table__empty">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {resetError !== null && (
          <div className="resource-error">
            <FormError message={resetError} />
          </div>
        )}

        {resetSuccess !== null && (
          <div className="resource-success" role="status">
            <p>{resetSuccess}</p>
          </div>
        )}
      </section>
    </main>
  );
}