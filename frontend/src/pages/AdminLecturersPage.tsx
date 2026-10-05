import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { createAdminLecturer, listAdminLecturers } from "../api/adminLecturers";
import { listAdminDepartments } from "../api/adminOrganization";
import { FormError } from "../components/FormError";
import type { AdminDepartment } from "../types/adminOrganization";
import type { AdminLecturer } from "../types/adminLecturer";

const MAX_STAFF_ID_LENGTH = 50;
const MAX_NAME_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 8;

interface LecturerFormState {
  staffId: string;
  name: string;
  departmentId: number | "";
  temporaryPassword: string;
  confirmPassword: string;
}

interface CreatedCredential {
  staffId: string;
  name: string;
  temporaryPassword: string;
}

function emptyFormState(): LecturerFormState {
  return { staffId: "", name: "", departmentId: "", temporaryPassword: "", confirmPassword: "" };
}

function listErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to manage lecturer accounts.";
    }
  }
  return "Lecturers could not be loaded. Please try again.";
}

function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to create lecturer accounts.";
    }
    if (error.status === 409) {
      return "A lecturer with this staff ID already exists.";
    }
    if (error.status === 404) {
      return "The selected department no longer exists. Please refresh and try again.";
    }
    if (error.status === 400) {
      return "Check the lecturer details and try again.";
    }
  }
  return "The lecturer account could not be created. Please try again.";
}

function isPositiveId(value: number | ""): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function AdminLecturersPage() {
  const [lecturers, setLecturers] = useState<AdminLecturer[] | null>(null);
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState<LecturerFormState>(emptyFormState());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [credential, setCredential] = useState<CreatedCredential | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const staffIdFieldId = useId();
  const nameFieldId = useId();
  const departmentFieldId = useId();
  const passwordFieldId = useId();
  const confirmPasswordFieldId = useId();

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminLecturers(), listAdminDepartments()])
      .then(([lecturerResult, departmentResult]) => {
        if (!cancelled) {
          setLecturers(lecturerResult.data);
          setDepartments(departmentResult.data);
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
  }, [reloadKey]);

  function refreshList(): void {
    setLecturers(null);
    setListError(null);
    setReloadKey((key) => key + 1);
  }

  function validateForm(state: LecturerFormState): Record<string, string> {
    const errors: Record<string, string> = {};
    const staffId = state.staffId.trim();
    const name = state.name.trim();
    if (staffId === "") {
      errors.staffId = "Please enter a staff ID.";
    } else if (staffId.length > MAX_STAFF_ID_LENGTH) {
      errors.staffId = `The staff ID must be ${MAX_STAFF_ID_LENGTH} characters or fewer.`;
    }
    if (name === "") {
      errors.name = "Please enter the lecturer's full name.";
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.name = `The name must be ${MAX_NAME_LENGTH} characters or fewer.`;
    }
    if (!isPositiveId(state.departmentId)) {
      errors.departmentId = "Please select a department.";
    }
    if (state.temporaryPassword === "") {
      errors.temporaryPassword = "Please enter a temporary password.";
    } else if (state.temporaryPassword.length < MIN_PASSWORD_LENGTH) {
      errors.temporaryPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (state.confirmPassword === "") {
      errors.confirmPassword = "Type the temporary password again.";
    } else if (state.confirmPassword !== state.temporaryPassword) {
      errors.confirmPassword = "The two passwords do not match.";
    }
    return errors;
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) {
      return;
    }

    setCreateError(null);
    setCredential(null);
    setCopyState("idle");
    const errors = validateForm(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    // The department list and the request carry the same identity, so a selection that is no longer
    // in the loaded list is a stale page rather than a bad department. Catch it here, where the
    // reload can be offered, instead of letting the API answer "no such department".
    const departmentId = draft.departmentId as number;
    if (!departments.some((department) => department.id === departmentId)) {
      setFieldErrors({
        departmentId: "That department is no longer in the list. Reload and select it again.",
      });
      refreshList();
      return;
    }

    setIsCreating(true);
    try {
      const created = await createAdminLecturer({
        staffId: draft.staffId.trim(),
        name: draft.name.trim(),
        departmentId,
        temporaryPassword: draft.temporaryPassword,
      });

      // The response is the only place this password will ever exist on this screen. It is
      // shown once here and never re-fetched: the API cannot return it again.
      setCredential({
        staffId: created.data.staffId,
        name: created.data.name,
        temporaryPassword: created.temporaryPassword,
      });
      setDraft(emptyFormState());
      setFieldErrors({});
      setIsPasswordVisible(true);
      refreshList();
    } catch (error) {
      setCreateError(createErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCopy() {
    if (credential === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(credential.temporaryPassword);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function dismissCredential(): void {
    setCredential(null);
    setIsPasswordVisible(false);
    setCopyState("idle");
  }

  const loading = lecturers === null && listError === null;

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Lecturer Management</h1>
          <p className="app-header__sub">
            Create lecturer accounts and issue the temporary password each lecturer changes at
            first sign-in.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      {listError !== null ? (
        <div className="resource-error">
          <FormError message={listError} />
          <button type="button" className="secondary-button" onClick={refreshList}>
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="inline-status" role="status">
          Loading lecturers…
        </p>
      ) : null}

      {lecturers !== null && lecturers.length === 0 ? (
        <div className="admin-empty">
          <p className="form-error admin-empty__message" role="status">
            No lecturers found.
          </p>
          <p className="inline-status">
            Lecturers will appear here once an account is created below.
          </p>
        </div>
      ) : null}

      {lecturers !== null && lecturers.length > 0 ? (
        <>
          <p className="inline-status" role="status">
            {lecturers.length === 1 ? "1 lecturer" : `${lecturers.length} lecturers`}
          </p>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Lecturer</th>
                  <th scope="col">Staff ID</th>
                  <th scope="col">Department</th>
                  <th scope="col">Status</th>
                  <th scope="col">First sign-in</th>
                </tr>
              </thead>
              <tbody>
                {lecturers.map((lecturer) => (
                  <tr key={lecturer.id} className="admin-table__row">
                    <td>{lecturer.name}</td>
                    <td>{lecturer.staffId}</td>
                    <td>
                      <span className="admin-table__primary">
                        {lecturer.departmentName}
                      </span>
                      <span className="admin-table__secondary">
                        {lecturer.departmentCode}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`student-status ${
                          lecturer.status === "ACTIVE"
                            ? "student-status--active"
                            : "student-status--inactive"
                        }`}
                      >
                        {lecturer.status}
                      </span>
                    </td>
                    <td>
                      {lecturer.mustChangePassword ? (
                        <span className="admin-table__secondary">
                          Temporary password pending
                        </span>
                      ) : (
                        <span className="admin-table__secondary">Changed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {credential !== null ? (
        <section
          className="app-card app-card--wide admin-compact-form-card"
          aria-labelledby="created-credential-heading"
        >
          <h2 id="created-credential-heading">Lecturer account created</h2>
          <p className="note">
            {credential.name} signs in with staff ID <strong>{credential.staffId}</strong> and
            must replace this temporary password at first sign-in. Copy it now: it is not stored
            in readable form and cannot be shown again.
          </p>
          <div className="confirm-row">
            <span className="credential-secret">
              {isPasswordVisible
                ? credential.temporaryPassword
                : "•".repeat(Math.max(credential.temporaryPassword.length, 8))}
            </span>
          </div>
          <div className="confirm-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIsPasswordVisible((visible) => !visible)}
            >
              {isPasswordVisible ? "Hide password" : "Show password"}
            </button>
            <button type="button" className="secondary-button" onClick={handleCopy}>
              Copy password
            </button>
            <button type="button" className="secondary-button" onClick={dismissCredential}>
              Done
            </button>
            <span className="inline-status" role="status">
              {copyState === "copied"
                ? "Password copied."
                : copyState === "failed"
                  ? "Copy failed. Reveal the password and copy it manually."
                  : ""}
            </span>
          </div>
        </section>
      ) : null}

      <section
        className="app-card app-card--wide admin-compact-form-card"
        aria-labelledby="create-lecturer-heading"
      >
        <h2 id="create-lecturer-heading">Create Lecturer</h2>
        <p className="note">
          The lecturer signs in with the staff ID and is restricted to the password-change screen
          until the temporary password is replaced.
        </p>
        <form
          className="admin-inline-form admin-compact-form"
          onSubmit={handleCreateSubmit}
          noValidate
        >
          <div className="field admin-inline-field">
            <label htmlFor={staffIdFieldId} className="field__label">
              Staff ID
            </label>
            <input
              id={staffIdFieldId}
              className="field__input"
              type="text"
              maxLength={MAX_STAFF_ID_LENGTH}
              placeholder="e.g. OOU/LEC/0142"
              value={draft.staffId}
              onChange={(event) =>
                setDraft((current) => ({ ...current, staffId: event.target.value }))
              }
              aria-invalid={fieldErrors.staffId !== undefined || undefined}
            />
            {fieldErrors.staffId !== undefined ? (
              <p className="field__error">{fieldErrors.staffId}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={nameFieldId} className="field__label">
              Full name
            </label>
            <input
              id={nameFieldId}
              className="field__input"
              type="text"
              maxLength={MAX_NAME_LENGTH}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              aria-invalid={fieldErrors.name !== undefined || undefined}
            />
            {fieldErrors.name !== undefined ? (
              <p className="field__error">{fieldErrors.name}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={departmentFieldId} className="field__label">
              Department
            </label>
            <select
              id={departmentFieldId}
              className="field__input"
              value={draft.departmentId}
              onChange={(event) => {
                // A <select> hands back a string. Convert once, here at the DOM boundary, so the
                // id the form submits is the number the departments API returned.
                const selected = event.target.value;
                setDraft((current) => ({
                  ...current,
                  departmentId: selected === "" ? "" : Number(selected),
                }));
              }}
              aria-invalid={fieldErrors.departmentId !== undefined || undefined}
            >
              <option value="">Select a department</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name} ({department.code})
                </option>
              ))}
            </select>
            {fieldErrors.departmentId !== undefined ? (
              <p className="field__error">{fieldErrors.departmentId}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={passwordFieldId} className="field__label">
              Temporary password
            </label>
            <input
              id={passwordFieldId}
              className="field__input"
              type={isPasswordVisible ? "text" : "password"}
              autoComplete="new-password"
              maxLength={200}
              value={draft.temporaryPassword}
              onChange={(event) =>
                setDraft((current) => ({ ...current, temporaryPassword: event.target.value }))
              }
              aria-invalid={fieldErrors.temporaryPassword !== undefined || undefined}
            />
            {fieldErrors.temporaryPassword !== undefined ? (
              <p className="field__error">{fieldErrors.temporaryPassword}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={confirmPasswordFieldId} className="field__label">
              Confirm temporary password
            </label>
            <input
              id={confirmPasswordFieldId}
              className="field__input"
              type={isPasswordVisible ? "text" : "password"}
              autoComplete="new-password"
              maxLength={200}
              value={draft.confirmPassword}
              onChange={(event) =>
                setDraft((current) => ({ ...current, confirmPassword: event.target.value }))
              }
              aria-invalid={fieldErrors.confirmPassword !== undefined || undefined}
            />
            {fieldErrors.confirmPassword !== undefined ? (
              <p className="field__error">{fieldErrors.confirmPassword}</p>
            ) : null}
          </div>
          <button
            type="submit"
            className="auth-submit admin-submit"
            disabled={isCreating}
            aria-busy={isCreating}
          >
            {isCreating ? "Creating…" : "Create lecturer"}
          </button>
        </form>
        {createError !== null ? (
          <div className="resource-error">
            <FormError message={createError} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
