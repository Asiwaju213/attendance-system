import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  getAdminAttendanceSession,
  listAdminAttendanceSessions,
  listAdminAttendanceNetworks,
  listAdminCourseOfferings,
  listAdminLocations,
} from "../api/attendance";
import type {
  AdminAttendanceSession,
  AdminCourseOffering,
  AdminSessionFilters,
  AttendanceLocation,
  AttendanceNetwork,
  SessionCurrentState,
  SessionStatus,
} from "../types/attendance";

interface FilterCatalogs {
  offerings: AdminCourseOffering[];
  networks: AttendanceNetwork[];
  locations: AttendanceLocation[];
}

interface DraftFilters {
  courseOfferingId: string;
  lecturerId: string;
  attendanceNetworkId: string;
  locationId: string;
  academicSessionId: string;
  semesterId: string;
  status: "" | SessionStatus;
  from: string;
  to: string;
}

interface ParseResult {
  filters: AdminSessionFilters;
  error: string | null;
}

interface Option {
  value: string;
  label: string;
}

function emptyDraft(): DraftFilters {
  return {
    courseOfferingId: "",
    lecturerId: "",
    attendanceNetworkId: "",
    locationId: "",
    academicSessionId: "",
    semesterId: "",
    status: "",
    from: "",
    to: "",
  };
}

function adminAttendanceErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "SESSION_NOT_FOUND") {
    return "This attendance session could not be found.";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "The filter could not be applied. Check the values and try again.";
  }
  return "Something went wrong. Please try again later.";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function positiveId(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function isoFromDateTimeLocal(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDraftFilters(draft: DraftFilters): ParseResult {
  const filters: AdminSessionFilters = {};

  const offeringId = positiveId(draft.courseOfferingId);
  if (offeringId !== null) {
    filters.courseOfferingId = offeringId;
  }

  if (draft.lecturerId.trim() !== "" && positiveId(draft.lecturerId) === null) {
    return {
      filters,
      error: "The Lecturer ID must be a positive whole number.",
    };
  }
  const lecturerId = positiveId(draft.lecturerId);
  if (lecturerId !== null) {
    filters.lecturerId = lecturerId;
  }

  const networkId = positiveId(draft.attendanceNetworkId);
  if (networkId !== null) {
    filters.attendanceNetworkId = networkId;
  }

  const locationId = positiveId(draft.locationId);
  if (locationId !== null) {
    filters.locationId = locationId;
  }

  const academicSessionId = positiveId(draft.academicSessionId);
  if (academicSessionId !== null) {
    filters.academicSessionId = academicSessionId;
  }

  const semesterId = positiveId(draft.semesterId);
  if (semesterId !== null) {
    filters.semesterId = semesterId;
  }

  if (draft.status !== "") {
    filters.status = draft.status;
  }

  const from = isoFromDateTimeLocal(draft.from);
  const to = isoFromDateTimeLocal(draft.to);
  if (from !== null) {
    filters.from = from;
  }
  if (to !== null) {
    filters.to = to;
  }
  if (
    from !== null &&
    to !== null &&
    new Date(from).getTime() > new Date(to).getTime()
  ) {
    return {
      filters,
      error: "The 'From date and time' must be on or before the 'To date and time'.",
    };
  }

  return { filters, error: null };
}

function stateBadgeClass(state: SessionCurrentState): string {
  switch (state) {
    case "ACTIVE":
      return "session-status--active";
    case "EXPIRED":
      return "session-status--expired";
    case "ENDED":
      return "session-status--ended";
  }
}

export function AdminAttendancePage() {
  const [catalogs, setCatalogs] = useState<FilterCatalogs | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const [draft, setDraft] = useState<DraftFilters>(emptyDraft);
  const [filterFormError, setFilterFormError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AdminSessionFilters>({});

  const [sessions, setSessions] = useState<AdminAttendanceSession[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [detail, setDetail] = useState<AdminAttendanceSession | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listAdminCourseOfferings(),
      listAdminAttendanceNetworks(),
      listAdminLocations(),
    ])
      .then(([offeringsRes, networksRes, locationsRes]) => {
        if (cancelled) {
          return;
        }
        setCatalogs({
          offerings: offeringsRes.data,
          networks: networksRes.data,
          locations: locationsRes.data,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError(
            "Some filter options could not be loaded. Please try again."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogReloadKey]);

  useEffect(() => {
    let cancelled = false;
    listAdminAttendanceSessions(applied)
      .then((res) => {
        if (!cancelled) {
          setSessions(res.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(adminAttendanceErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    let cancelled = false;
    getAdminAttendanceSession(selectedId)
      .then((res) => {
        if (!cancelled) {
          setDetail(res.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(adminAttendanceErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailReloadKey]);

  const academicSessionOptions = useMemo<Option[]>(() => {
    const seen = new Map<number, string>();
    for (const offering of catalogs?.offerings ?? []) {
      if (!seen.has(offering.academicSessionId)) {
        seen.set(offering.academicSessionId, offering.academicSessionName);
      }
    }
    return [...seen.entries()]
      .map(([value, name]) => ({ value: String(value), label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [catalogs]);

  const semesterOptions = useMemo<Option[]>(() => {
    const seen = new Map<number, string>();
    for (const offering of catalogs?.offerings ?? []) {
      if (!seen.has(offering.semesterId)) {
        seen.set(offering.semesterId, offering.semesterName);
      }
    }
    return [...seen.entries()]
      .map(([value, name]) => ({ value: String(value), label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [catalogs]);

  function updateDraft(field: keyof DraftFilters, value: string): void {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function handleApply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const result = parseDraftFilters(draft);
    if (result.error !== null) {
      setFilterFormError(result.error);
      return;
    }
    setFilterFormError(null);
    setSessions(null);
    setListError(null);
    setSelectedId(null);
    setApplied(result.filters);
  }

  function handleClear(): void {
    setDraft(emptyDraft());
    setFilterFormError(null);
    setSessions(null);
    setListError(null);
    setSelectedId(null);
    setApplied({});
  }

  function reloadSessions(): void {
    setSessions(null);
    setListError(null);
    setApplied((prev) => ({ ...prev }));
  }

  function reloadCatalogs(): void {
    setCatalogError(null);
    setCatalogs(null);
    setCatalogReloadKey((prev) => prev + 1);
  }

  function openDetails(id: number): void {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
  }

  function closeDetails(): void {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  function retryDetail(): void {
    if (selectedId === null) {
      return;
    }
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setDetailReloadKey((prev) => prev + 1);
  }

  const catalogLoading = catalogs === null && catalogError === null;

  const offeringOptions: Option[] = (catalogs?.offerings ?? []).map((offering) => ({
    value: String(offering.id),
    label: `${offering.courseCode} — ${offering.courseTitle} · ${offering.academicSessionName} · ${offering.semesterName}`,
  }));
  const networkOptions: Option[] = (catalogs?.networks ?? []).map((network) => ({
    value: String(network.id),
    label: `${network.networkCode} — ${network.name}`,
  }));
  const locationOptions: Option[] = (catalogs?.locations ?? []).map((location) => ({
    value: String(location.id),
    label: location.name,
  }));

  const listLoading = sessions === null && listError === null;

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Attendance Monitoring</h1>
          <p className="app-header__sub">
            Browse and view attendance sessions across all lecturers.
          </p>
        </div>
        <nav className="app-header__nav">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="filter-title">
        <h2 id="filter-title">Filters</h2>
        {catalogError !== null ? (
          <div className="resource-error admin-filter-catalog-error">
            <p className="form-error">{catalogError}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={reloadCatalogs}
              aria-busy={catalogLoading}
            >
              Retry options
            </button>
          </div>
        ) : null}
        {filterFormError !== null ? (
          <p role="alert" className="form-error">
            {filterFormError}
          </p>
        ) : null}
        <form onSubmit={handleApply}>
          <div className="admin-filter-grid">
            <div className="field">
              <label className="field__label" htmlFor="filter-offering">
                Course offering
              </label>
              <select
                id="filter-offering"
                className="field__input"
                value={draft.courseOfferingId}
                onChange={(event) => updateDraft("courseOfferingId", event.target.value)}
              >
                <option value="">Any course offering</option>
                {offeringOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-lecturer">
                Lecturer ID
              </label>
              <input
                id="filter-lecturer"
                className="field__input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 12"
                value={draft.lecturerId}
                onChange={(event) => updateDraft("lecturerId", event.target.value)}
                aria-invalid={filterFormError !== null && /Lecturer ID/i.test(filterFormError)}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-network">
                Attendance network
              </label>
              <select
                id="filter-network"
                className="field__input"
                value={draft.attendanceNetworkId}
                onChange={(event) => updateDraft("attendanceNetworkId", event.target.value)}
              >
                <option value="">Any attendance network</option>
                {networkOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-location">
                Location
              </label>
              <select
                id="filter-location"
                className="field__input"
                value={draft.locationId}
                onChange={(event) => updateDraft("locationId", event.target.value)}
              >
                <option value="">Any location</option>
                {locationOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-session">
                Academic session
              </label>
              <select
                id="filter-session"
                className="field__input"
                value={draft.academicSessionId}
                onChange={(event) => updateDraft("academicSessionId", event.target.value)}
              >
                <option value="">Any academic session</option>
                {academicSessionOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-semester">
                Semester
              </label>
              <select
                id="filter-semester"
                className="field__input"
                value={draft.semesterId}
                onChange={(event) => updateDraft("semesterId", event.target.value)}
              >
                <option value="">Any semester</option>
                {semesterOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-status">
                Status
              </label>
              <select
                id="filter-status"
                className="field__input"
                value={draft.status}
                onChange={(event) =>
                  updateDraft("status", event.target.value as "" | SessionStatus)
                }
              >
                <option value="">Any status</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="ENDED">ENDED</option>
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-from">
                From date and time
              </label>
              <input
                id="filter-from"
                className="field__input"
                type="datetime-local"
                value={draft.from}
                onChange={(event) => updateDraft("from", event.target.value)}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="filter-to">
                To date and time
              </label>
              <input
                id="filter-to"
                className="field__input"
                type="datetime-local"
                value={draft.to}
                onChange={(event) => updateDraft("to", event.target.value)}
              />
            </div>
          </div>

          <p className="admin-filter-note">
            Filters apply to the session list when you press Apply.
          </p>
          <div className="confirm-row">
            <button
              type="submit"
              className="auth-submit admin-submit"
              disabled={listLoading}
              aria-busy={listLoading}
            >
              Apply filters
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleClear}
              disabled={listLoading}
            >
              Clear filters
            </button>
          </div>
        </form>
      </section>

      <section className="app-card app-card--wide" aria-label="Attendance sessions">
        <h2>Sessions</h2>
        {listError !== null ? (
          <div className="resource-error">
            <p role="alert" className="form-error">
              {listError}
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={reloadSessions}
            >
              Retry
            </button>
          </div>
        ) : sessions === null ? (
          <p className="inline-status" aria-busy={listLoading}>
            Loading attendance sessions…
          </p>
        ) : sessions.length === 0 ? (
          <div className="admin-empty">
            <p className="form-error admin-empty__message" role="status">
              No attendance sessions match the current filters.
            </p>
            <p className="inline-status">
              Try adjusting the filters, or clear them to see all sessions.
            </p>
          </div>
        ) : (
          <>
            <p className="inline-status" role="status">
              {sessions.length === 1 ? "1 session" : `${sessions.length} sessions`}
            </p>
            <div className="admin-table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Course</th>
                    <th scope="col">Lecturer</th>
                    <th scope="col">Network</th>
                    <th scope="col">Location</th>
                    <th scope="col">Start</th>
                    <th scope="col">End</th>
                    <th scope="col">State</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id} className="admin-table__row">
                      <td>
                        <span className="admin-table__primary">
                          {session.courseCode}
                        </span>
                        <span className="admin-table__secondary">
                          {session.courseTitle}
                        </span>
                      </td>
                      <td>
                        <span className="admin-table__primary">
                          {session.lecturerName}
                        </span>
                        <span className="admin-table__secondary">
                          {session.lecturerStaffId}
                        </span>
                      </td>
                      <td>
                        <span className="admin-table__primary">
                          {session.attendanceNetworkCode}
                        </span>
                        <span className="admin-table__secondary">
                          {session.attendanceNetworkName}
                        </span>
                      </td>
                      <td>{session.locationName}</td>
                      <td>{formatDateTime(session.startTime)}</td>
                      <td>{formatDateTime(session.endTime)}</td>
                      <td>
                        <span
                          className={`session-status ${stateBadgeClass(session.currentState)}`}
                        >
                          {session.currentState}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary-button admin-table__view"
                          onClick={() => openDetails(session.id)}
                        >
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {selectedId !== null ? (
        <section className="app-card app-card--wide" aria-label="Session details">
          <div className="admin-detail__header">
            <h2>Session details</h2>
            <button
              type="button"
              className="secondary-button"
              onClick={closeDetails}
            >
              Back to sessions
            </button>
          </div>
          {detailLoading ? (
            <p className="inline-status" aria-busy>
              Loading session details…
            </p>
          ) : detailError !== null ? (
            <div className="resource-error">
              <p role="alert" className="form-error">
                {detailError}
              </p>
              <button
                type="button"
                className="secondary-button"
                onClick={retryDetail}
              >
                Retry
              </button>
            </div>
          ) : detail !== null ? (
            <div className="session-detail admin-detail">
              <p>
                <span className="app-detail__label">Course: </span>
                {detail.courseCode} — {detail.courseTitle}
              </p>
              <p>
                <span className="app-detail__label">Lecturer: </span>
                {detail.lecturerName} ({detail.lecturerStaffId})
              </p>
              <p>
                <span className="app-detail__label">Academic session: </span>
                {detail.academicSessionName} · {detail.semesterName}
              </p>
              <p>
                <span className="app-detail__label">Attendance network: </span>
                {detail.attendanceNetworkCode} — {detail.attendanceNetworkName}
              </p>
              <p>
                <span className="app-detail__label">Location: </span>
                {detail.locationName}
              </p>
              <p>
                <span className="app-detail__label">Started at: </span>
                {formatDateTime(detail.startTime)}
              </p>
              <p>
                <span className="app-detail__label">Scheduled end: </span>
                {formatDateTime(detail.endTime)}
              </p>
              <p>
                <span className="app-detail__label">Late threshold: </span>
                {detail.lateThresholdMinutes} minutes
              </p>
              <p>
                <span className="app-detail__label">Status: </span>
                {detail.status}
              </p>
              <p>
                <span className="app-detail__label">Current state: </span>
                <span
                  className={`session-status ${stateBadgeClass(detail.currentState)}`}
                >
                  {detail.currentState}
                </span>
              </p>
              {detail.endedAt !== null ? (
                <p>
                  <span className="app-detail__label">Ended at: </span>
                  {formatDateTime(detail.endedAt)}
                </p>
              ) : null}
              <p>
                <span className="app-detail__label">Created at: </span>
                {formatDateTime(detail.createdAt)}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {catalogs === null && catalogLoading ? (
        <p className="admin-catalog-loading">Loading filter options…</p>
      ) : null}
    </main>
  );
}