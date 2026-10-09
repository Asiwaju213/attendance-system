import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { listAdminDepartments } from "../api/adminOrganization";
import {
  confirmStudentImport,
  downloadStudentImportTemplate,
  previewStudentImport,
  StudentImportApiError,
} from "../api/adminStudentImport";
import { FormError } from "../components/FormError";
import { ADMIN_LEVEL_OPTIONS } from "../lib/adminLevels";
import type { AdminDepartment } from "../types/adminOrganization";
import type {
  StudentImportPreview,
  StudentImportResult,
} from "../types/adminStudentImport";

function catalogErrorMessage(): string {
  return "The department list could not be loaded. Try again to select a department.";
}

function importErrorMessage(error: unknown): string {
  if (error instanceof StudentImportApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to import students.";
    }
    if (error.serverMessage !== null && error.serverMessage.length > 0) {
      return error.serverMessage;
    }
    if (error.status === 404) {
      return "The department, level, or import preview could not be found. Refresh and try again.";
    }
    if (error.status === 409) {
      return "The import could not be completed because the student data changed. Preview the file again.";
    }
    if (error.status === 413) {
      return "The uploaded file is too large.";
    }
    if (error.status === 400) {
      return "The uploaded file could not be read. Upload a valid .xlsx workbook.";
    }
  }
  return "Unable to reach the server. Check your connection and try again.";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

export function AdminStudentImportPage() {
  const [departments, setDepartments] = useState<AdminDepartment[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  const [departmentId, setDepartmentId] = useState("");
  const [levelId, setLevelId] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [preview, setPreview] = useState<StudentImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [result, setResult] = useState<StudentImportResult | null>(null);

  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewRequestRef = useRef(0);

  const departmentSelectId = useId();
  const levelSelectId = useId();
  const fileInputId = useId();

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

  function resetImportWorkflow(): void {
    previewRequestRef.current += 1;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setConfirmError(null);
    setConfirming(false);
    setResult(null);
    setFormError(null);
    setFileError(null);
  }

  function clearFile(): void {
    resetImportWorkflow();
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function triggerFilePicker(): void {
    fileInputRef.current?.click();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    if (selected === null) {
      return;
    }
    event.target.value = "";

    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx") {
      resetImportWorkflow();
      setFile(null);
      setFileError(
        "Choose a .xlsx workbook. Files saved in other formats cannot be imported."
      );
      return;
    }

    resetImportWorkflow();
    setFile(selected);
  }

  async function handleDownloadTemplate(): Promise<void> {
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      await downloadStudentImportTemplate();
    } catch (error) {
      setTemplateError(importErrorMessage(error));
    } finally {
      setTemplateBusy(false);
    }
  }

  async function handlePreview(): Promise<void> {
    if (departmentId === "") {
      setFormError("Select a department to import into.");
      return;
    }
    if (levelId === "") {
      setFormError("Select a level for the imported students.");
      return;
    }
    if (file === null) {
      setFormError("Choose a .xlsx workbook to import.");
      return;
    }

    setFormError(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setConfirmError(null);
    setResult(null);

    const requestId = ++previewRequestRef.current;
    try {
      const response = await previewStudentImport({
        departmentId,
        levelId,
        file,
      });
      if (previewRequestRef.current !== requestId) {
        return;
      }
      setPreview(response.data);
    } catch (error) {
      if (previewRequestRef.current !== requestId) {
        return;
      }
      setPreviewError(importErrorMessage(error));
    } finally {
      if (previewRequestRef.current === requestId) {
        setPreviewLoading(false);
      }
    }
  }

  async function handleConfirm(): Promise<void> {
    if (preview === null) {
      return;
    }
    setConfirming(true);
    setConfirmError(null);
    try {
      const response = await confirmStudentImport(preview.previewToken);
      setResult(response.data);
      setPreview(null);
      setPreviewError(null);
    } catch (error) {
      setConfirmError(importErrorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  function handleImportAnother(): void {
    resetImportWorkflow();
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setTemplateError(null);
  }

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Student import</h1>
          <p className="app-header__sub">
            Create student accounts in bulk from a workbook.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Admin navigation">
          <Link to="/app/admin">Back to Admin Home</Link>
        </nav>
      </header>

      <section className="app-card" aria-labelledby="import-settings-heading">
        <h2 id="import-settings-heading">Import settings</h2>

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
            <label htmlFor={departmentSelectId} className="field__label">
              Department
            </label>
            <select
              id={departmentSelectId}
              className="field__input"
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
                resetImportWorkflow();
              }}
            >
              <option value="">Select a department</option>
              {(departments ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name} ({department.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={levelSelectId} className="field__label">
              Level
            </label>
            <select
              id={levelSelectId}
              className="field__input"
              value={levelId}
              onChange={(event) => {
                setLevelId(event.target.value);
                resetImportWorkflow();
              }}
            >
              <option value="">Select a level</option>
              {ADMIN_LEVEL_OPTIONS.map((level) => (
                <option key={level.id} value={level.id}>
                  Level {level.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="admin-filter-note">
          Every imported student is created in the department and level selected here.
        </p>
      </section>

      <section className="app-card" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Upload workbook</h2>
        <p className="admin-filter-note">
          The workbook must be an .xlsx file. Its first row must contain
          &ldquo;Student Name&rdquo; and &ldquo;Matric Number&rdquo; columns; the
          template below already has them.
        </p>

        <div className="confirm-row">
          <button
            type="button"
            className="secondary-button"
            onClick={handleDownloadTemplate}
            disabled={templateBusy}
            aria-busy={templateBusy}
          >
            {templateBusy ? "Preparing…" : "Download template"}
          </button>
        </div>
        {templateError !== null ? <FormError message={templateError} /> : null}

        <div className="field">
          <label htmlFor={fileInputId} className="field__label">
            Student data workbook
          </label>
          {/*
            The visible "Choose .xlsx file" button proxies to this input, so the
            input is hidden from both the accessibility tree and the tab order.
            The label above is what names the control for assistive technology.
          */}
          <input
            id={fileInputId}
            ref={fileInputRef}
            className="import-file-input"
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            tabIndex={-1}
            aria-hidden="true"
          />
          {file === null ? (
            <button
              type="button"
              className="secondary-button"
              onClick={triggerFilePicker}
            >
              Choose .xlsx file
            </button>
          ) : (
            <div className="import-file-chip">
              <span className="import-file-chip__name">{file.name}</span>
              <span className="import-file-chip__size">
                {formatFileSize(file.size)}
              </span>
<div className="confirm-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={triggerFilePicker}
                  >
                    Change file
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={clearFile}
                  >
                    Remove file
                  </button>
                </div>
            </div>
          )}
          {fileError !== null ? <FormError message={fileError} /> : null}
        </div>

        {formError !== null ? <FormError message={formError} /> : null}

        <div className="confirm-row">
          <button
            type="button"
            className="auth-submit admin-submit"
            onClick={handlePreview}
            disabled={previewLoading || templateBusy}
          >
            {previewLoading ? "Previewing…" : "Preview import"}
          </button>
        </div>
      </section>

      {preview !== null || previewError !== null || previewLoading ? (
        <section
          className="app-card app-card--wide"
          aria-labelledby="preview-heading"
        >
          <h2 id="preview-heading">Preview</h2>

          {previewError !== null ? (
            <div className="resource-error">
              <FormError message={previewError} />
              <button
                type="button"
                className="secondary-button"
                onClick={handlePreview}
              >
                Retry
              </button>
            </div>
          ) : null}

          {previewLoading ? (
            <p className="inline-status" role="status">
              Checking the workbook…
            </p>
          ) : null}

          {preview !== null ? (
            <>
              <div className="import-summary" role="status">
                <div className="import-summary__stat">
                  <span className="import-summary__value">{preview.totalRows}</span>
                  <span className="import-summary__label">Total rows</span>
                </div>
                <div className="import-summary__stat">
                  <span className="import-summary__value">
                    {preview.validRows}
                  </span>
                  <span className="import-summary__label">Ready to import</span>
                </div>
                <div className="import-summary__stat">
                  <span className="import-summary__value">
                    {preview.invalidRows}
                  </span>
                  <span className="import-summary__label">Need attention</span>
                </div>
              </div>

              <p className="admin-filter-note">
                {preview.department.name} · Level {preview.level.name} ·{" "}
                {preview.totalRows > 0
                  ? `${countLabel(preview.totalRows, "student", "students")} read from the workbook`
                  : "no student rows in this preview"}
              </p>

              {preview.rows.length > 0 ? (
                <div className="admin-table-scroll">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">Row</th>
                        <th scope="col">Student Name</th>
                        <th scope="col">Matric Number</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.rowNumber} className="admin-table__row">
                          <td>{row.rowNumber}</td>
                          <td>
                            <span className="admin-table__primary">
                              {row.studentName}
                            </span>
                          </td>
                          <td>
                            <span className="admin-table__secondary">
                              {row.matricNumber}
                            </span>
                          </td>
                          <td>
                            <span
                              className={
                                row.valid
                                  ? "import-row-valid"
                                  : "import-row-invalid"
                              }
                            >
                              {row.valid ? "Valid" : "Invalid"}
                            </span>
                            {!row.valid && row.errors.length > 0 ? (
                              <ul className="import-row-errors">
                                {row.errors.map((message) => (
                                  <li key={message}>{message}</li>
                                ))}
                              </ul>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {preview.invalidRows > 0 ? (
                <div className="confirm-row confirm-row--block">
                  <p className="confirm-message">
                    Fix the{" "}
                    {countLabel(
                      preview.invalidRows,
                      "row",
                      "rows"
                    )}{" "}
                    marked in the workbook, then replace the file and preview
                    again. Nothing has been imported.
                  </p>
                </div>
              ) : null}

              {preview.invalidRows === 0 && result === null ? (
                <div className="confirm-row confirm-row--block">
                  <p className="confirm-message">
                    Importing {countLabel(preview.totalRows, "student", "students")} into{" "}
                    {preview.department.name} at Level {preview.level.name}? This will:
                  </p>
                  <ul className="confirm-message__list">
                    <li>
                      create{" "}
                      {countLabel(
                        preview.totalRows,
                        "new account awaiting registration",
                        "new accounts awaiting registration"
                      )}
                      , and
                    </li>
                    <li>
                      leave them without a password until each student completes
                      registration, and
                    </li>
                    <li>
                      import the whole batch together: either every row is
                      imported, or none is.
                    </li>
                  </ul>
                  {confirmError !== null ? (
                    <FormError message={confirmError} />
                  ) : null}
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="auth-submit admin-submit"
                      onClick={handleConfirm}
                      disabled={confirming}
                      aria-busy={confirming}
                    >
                      {confirming ? "Importing…" : "Confirm import"}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {result !== null ? (
        <section className="app-card" aria-labelledby="result-heading">
          <h2 id="result-heading">Import complete</h2>
          <div className="resource-success" role="status">
            <p>
              {countLabel(result.importedCount, "student", "students")} imported
              successfully. Each new account must complete registration before
              it can sign in.
            </p>
          </div>
          <div className="confirm-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={handleImportAnother}
            >
              Import another file
            </button>
            <Link
              to="/app/admin/students"
              className="secondary-button"
            >
              Return to student management
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}