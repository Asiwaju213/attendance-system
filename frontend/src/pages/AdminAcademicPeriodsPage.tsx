import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import type { FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  createAcademicSession,
  listAcademicSessions,
  listSemesters,
  updateAcademicSession,
  updateSemester,
} from "../api/academicPeriods";
import type { AcademicSession, Semester } from "../types/academicPeriod";
import { FormError } from "../components/FormError";

const ALLOWED_SEMESTER_NAMES = ["First Semester", "Second Semester"];

const MAX_NAME_LENGTH = 200;

function academicSessionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return "The session name must be between 1 and 200 characters.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return "An academic session with this name already exists.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This academic session no longer exists. The list has been refreshed.";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You do not have permission to manage academic sessions.";
  }
  return "Something went wrong. Please try again later.";
}

function semesterErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return "Semester names must be 'First Semester' or 'Second Semester'.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return "A semester with this name already exists.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This semester no longer exists. The list has been refreshed.";
  }
  if (error instanceof ApiError && error.status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "You do not have permission to manage semesters.";
  }
  return "Something went wrong. Please try again later.";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AdminAcademicPeriodsPage() {
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsReloadKey, setSessionsReloadKey] = useState(0);

  const [newName, setNewName] = useState("");
  const [createFieldError, setCreateFieldError] = useState<string | null>(null);
  const [createFormError, setCreateFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [renameFieldError, setRenameFieldError] = useState<string | null>(null);
  const [renameFormError, setRenameFormError] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);

  const [busyToggleId, setBusyToggleId] = useState<number | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [semesters, setSemesters] = useState<Semester[] | null>(null);
  const [semestersError, setSemestersError] = useState<string | null>(null);
  const [semestersReloadKey, setSemestersReloadKey] = useState(0);

  const [editingSemesterId, setEditingSemesterId] = useState<number | null>(null);
  const [editingSemesterDraft, setEditingSemesterDraft] = useState("");
  const [semesterFieldError, setSemesterFieldError] = useState<string | null>(
    null
  );
  const [semesterFormError, setSemesterFormError] = useState<string | null>(null);
  const [isSavingSemester, setIsSavingSemester] = useState(false);

  const newNameId = useId();
  const editingNameId = useId();
  const editingSemesterNameId = useId();

  useEffect(() => {
    let cancelled = false;
    listAcademicSessions()
      .then((result) => {
        if (!cancelled) {
          setSessions(result.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSessionsError(academicSessionErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsReloadKey]);

  useEffect(() => {
    let cancelled = false;
    listSemesters()
      .then((result) => {
        if (!cancelled) {
          setSemesters(result.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSemestersError(semesterErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [semestersReloadKey]);

  function refreshSessions(): void {
    setSessions(null);
    setSessionsError(null);
    setSessionsReloadKey((key) => key + 1);
  }

  function refreshSemesters(): void {
    setSemesters(null);
    setSemestersError(null);
    setSemestersReloadKey((key) => key + 1);
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) {
      return;
    }

    setCreateFormError(null);
    const trimmed = newName.trim();
    if (trimmed === "") {
      setCreateFieldError("Please enter an academic session name.");
      return;
    }
    setCreateFieldError(null);

    setIsCreating(true);
    try {
      await createAcademicSession(trimmed);
      setNewName("");
      refreshSessions();
    } catch (error) {
      setCreateFormError(academicSessionErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  function startRename(session: AcademicSession): void {
    setEditingId(session.id);
    setEditingDraft(session.name);
    setRenameFieldError(null);
    setRenameFormError(null);
  }

  function cancelRename(): void {
    setEditingId(null);
    setEditingDraft("");
    setRenameFieldError(null);
    setRenameFormError(null);
  }

  async function handleRenameSubmit(
    sessionId: number,
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (isSavingRename) {
      return;
    }

    setRenameFormError(null);
    const trimmed = editingDraft.trim();
    if (trimmed === "") {
      setRenameFieldError("The session name cannot be empty.");
      return;
    }
    setRenameFieldError(null);

    setIsSavingRename(true);
    try {
      await updateAcademicSession(sessionId, { name: trimmed });
      cancelRename();
      refreshSessions();
    } catch (error) {
      setRenameFormError(academicSessionErrorMessage(error));
    } finally {
      setIsSavingRename(false);
    }
  }

  async function handleToggle(session: AcademicSession) {
    if (busyToggleId !== null) {
      return;
    }

    setToggleError(null);
    setBusyToggleId(session.id);
    try {
      await updateAcademicSession(session.id, { isActive: !session.isActive });
      refreshSessions();
    } catch (error) {
      setToggleError(academicSessionErrorMessage(error));
    } finally {
      setBusyToggleId(null);
    }
  }

  function startEditSemester(semester: Semester): void {
    setEditingSemesterId(semester.id);
    setEditingSemesterDraft(semester.name);
    setSemesterFieldError(null);
    setSemesterFormError(null);
  }

  function cancelEditSemester(): void {
    setEditingSemesterId(null);
    setEditingSemesterDraft("");
    setSemesterFieldError(null);
    setSemesterFormError(null);
  }

  async function handleSemesterSubmit(
    semesterId: number,
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (isSavingSemester) {
      return;
    }

    setSemesterFormError(null);
    const trimmed = editingSemesterDraft.trim();
    if (!ALLOWED_SEMESTER_NAMES.includes(trimmed)) {
      setSemesterFieldError(
        "Semester names must be 'First Semester' or 'Second Semester'."
      );
      return;
    }
    setSemesterFieldError(null);

    setIsSavingSemester(true);
    try {
      await updateSemester(semesterId, trimmed);
      cancelEditSemester();
      refreshSemesters();
    } catch (error) {
      setSemesterFormError(semesterErrorMessage(error));
    } finally {
      setIsSavingSemester(false);
    }
  }

  const sessionsLoading = sessions === null && sessionsError === null;
  const semestersLoading = semesters === null && semestersError === null;

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Academic Sessions &amp; Semesters</h1>
          <p className="app-header__sub">
            Manage the active academic session and the two supported semesters.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Academic Sessions</h2>
        <p className="note">
          Activating an academic session deactivates the previous one. Students
          register against the active session.
        </p>

        {sessionsError !== null ? (
          <div className="resource-error">
            <FormError message={sessionsError} />
            <button
              type="button"
              className="secondary-button"
              onClick={refreshSessions}
            >
              Retry
            </button>
          </div>
        ) : null}

        {sessionsLoading ? (
          <p className="inline-status" role="status">
            Loading academic sessions…
          </p>
        ) : null}

        {sessions !== null && sessions.length === 0 ? (
          <div className="admin-empty">
            <p className="form-error admin-empty__message" role="status">
              No academic sessions yet.
            </p>
          </div>
        ) : null}

        {sessions !== null && sessions.length > 0 ? (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Academic session</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="admin-table__row">
                    <td>
                      {editingId === session.id ? (
                        <form
                          className="admin-inline-form"
                          onSubmit={(event) => handleRenameSubmit(session.id, event)}
                          noValidate
                        >
                          <label className="visually-hidden" htmlFor={editingNameId}>
                            Academic session name
                          </label>
                          <input
                            id={editingNameId}
                            className="field__input"
                            type="text"
                            maxLength={MAX_NAME_LENGTH}
                            value={editingDraft}
                            onChange={(event) => setEditingDraft(event.target.value)}
                            aria-invalid={renameFieldError !== null || undefined}
                          />
                          {renameFieldError !== null ? (
                            <p className="field__error">{renameFieldError}</p>
                          ) : null}
                          {renameFormError !== null ? (
                            <FormError message={renameFormError} />
                          ) : null}
                          <div className="confirm-row">
                            <button
                              type="submit"
                              className="secondary-button"
                              disabled={isSavingRename}
                              aria-busy={isSavingRename}
                            >
                              {isSavingRename ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={cancelRename}
                              disabled={isSavingRename}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <span className="admin-table__primary">{session.name}</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`session-status ${
                          session.isActive
                            ? "session-status--active"
                            : "academic-status--inactive"
                        }`}
                      >
                        {session.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>{formatDateTime(session.createdAt)}</td>
                    <td>
                      {editingId === session.id ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled
                        >
                          Editing…
                        </button>
                      ) : (
                        <div className="confirm-row">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => startRename(session)}
                            disabled={busyToggleId !== null || isCreating}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleToggle(session)}
                            disabled={
                              busyToggleId !== null ||
                              isCreating ||
                              editingId !== null
                            }
                            aria-busy={busyToggleId === session.id}
                          >
                            {busyToggleId === session.id
                              ? session.isActive
                                ? "Deactivating…"
                                : "Activating…"
                              : session.isActive
                                ? "Deactivate"
                                : "Activate"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {toggleError !== null ? (
          <div className="resource-error">
            <FormError message={toggleError} />
          </div>
        ) : null}

        <div className="app-card__actions">
          <form onSubmit={handleCreateSubmit} noValidate className="admin-inline-form">
            <div className="field admin-inline-field">
              <label htmlFor={newNameId} className="field__label">
                New academic session name
              </label>
              <input
                id={newNameId}
                className="field__input"
                type="text"
                maxLength={MAX_NAME_LENGTH}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                aria-invalid={createFieldError !== null || undefined}
              />
              {createFieldError !== null ? (
                <p className="field__error">{createFieldError}</p>
              ) : null}
            </div>
            <button
              type="submit"
              className="auth-submit admin-submit"
              disabled={isCreating}
              aria-busy={isCreating}
            >
              {isCreating ? "Adding…" : "Add session"}
            </button>
          </form>
          {createFormError !== null ? (
            <FormError message={createFormError} />
          ) : null}
        </div>
      </section>

      <section className="app-card app-card--wide" aria-labelledby="semesters-heading">
        <h2 id="semesters-heading">Semesters</h2>
        <p className="note">
          Only First Semester and Second Semester are supported. A semester name
          can only be switched to the other supported name.
        </p>

        {semestersError !== null ? (
          <div className="resource-error">
            <FormError message={semestersError} />
            <button
              type="button"
              className="secondary-button"
              onClick={refreshSemesters}
            >
              Retry
            </button>
          </div>
        ) : null}

        {semestersLoading ? (
          <p className="inline-status" role="status">
            Loading semesters…
          </p>
        ) : null}

        {semesters !== null && semesters.length === 0 ? (
          <div className="admin-empty">
            <p className="form-error admin-empty__message" role="status">
              No semesters found.
            </p>
          </div>
        ) : null}

        {semesters !== null && semesters.length > 0 ? (
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Semester</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {semesters.map((semester) => (
                  <tr key={semester.id} className="admin-table__row">
                    <td>
                      {editingSemesterId === semester.id ? (
                        <form
                          className="admin-inline-form"
                          onSubmit={(event) =>
                            handleSemesterSubmit(semester.id, event)
                          }
                          noValidate
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={editingSemesterNameId}
                          >
                            Semester name
                          </label>
                          <input
                            id={editingSemesterNameId}
                            className="field__input"
                            type="text"
                            maxLength={MAX_NAME_LENGTH}
                            value={editingSemesterDraft}
                            onChange={(event) =>
                              setEditingSemesterDraft(event.target.value)
                            }
                            aria-invalid={semesterFieldError !== null || undefined}
                          />
                          {semesterFieldError !== null ? (
                            <p className="field__error">{semesterFieldError}</p>
                          ) : null}
                          {semesterFormError !== null ? (
                            <FormError message={semesterFormError} />
                          ) : null}
                          <div className="confirm-row">
                            <button
                              type="submit"
                              className="secondary-button"
                              disabled={isSavingSemester}
                              aria-busy={isSavingSemester}
                            >
                              {isSavingSemester ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={cancelEditSemester}
                              disabled={isSavingSemester}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <span className="admin-table__primary">{semester.name}</span>
                      )}
                    </td>
                    <td>{formatDateTime(semester.createdAt)}</td>
                    <td>
                      {editingSemesterId === semester.id ? (
                        <button type="button" className="secondary-button" disabled>
                          Editing…
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => startEditSemester(semester)}
                          disabled={isSavingSemester}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}