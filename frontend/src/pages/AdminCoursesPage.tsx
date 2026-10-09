import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createAdminCourse,
  listAdminCourses,
  updateAdminCourse,
} from "../api/adminCourses";
import { listAdminDepartments, listAdminFaculties } from "../api/adminOrganization";
import { ApiError } from "../api/client";
import { FormError } from "../components/FormError";
import { ADMIN_LEVEL_OPTIONS } from "../lib/adminLevels";
import { statusLabel } from "../lib/format";
import type {
  AdminCourse,
  AdminCourseCreateInput,
  AdminCourseUpdateInput,
  CourseScope,
  CourseStatus,
} from "../types/adminCourse";
import type { AdminDepartment, AdminFaculty } from "../types/adminOrganization";

const MAX_COURSE_CODE_LENGTH = 32;
const MAX_TITLE_LENGTH = 200;

function coursesErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to manage courses.";
    }
  }
  return "The courses could not be loaded. Please try again.";
}

function courseWriteErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Your session has expired. Please sign in again.";
    }
    if (error.status === 403) {
      return "You do not have permission to manage courses.";
    }
    if (error.status === 400) {
      return "Check the course details and try again.";
    }
    if (error.status === 409) {
      return "A course with this code already exists.";
    }
    if (error.status === 404) {
      return "A selected faculty, department, or level no longer exists. Please refresh and try again.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function courseStatusClass(status: CourseStatus): string {
  return status === "ACTIVE" ? "student-status--active" : "student-status--inactive";
}

function isPositiveId(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

function ownerPayload(
  scope: CourseScope,
  ownerId: string
): { facultyId?: number; departmentId?: number } {
  if (!isPositiveId(ownerId)) {
    return {};
  }
  const id = Number(ownerId);
  return scope === "FACULTY" ? { facultyId: id } : { departmentId: id };
}

interface CourseFormState {
  code: string;
  title: string;
  levelId: string;
  scope: CourseScope;
  ownerId: string;
}

function emptyFormState(scope: CourseScope = "FACULTY"): CourseFormState {
  return { code: "", title: "", levelId: "", scope, ownerId: "" };
}

function formInitialErrors(): Record<string, string> {
  return {};
}

export function AdminCoursesPage() {
  const [courses, setCourses] = useState<AdminCourse[] | null>(null);
  const [faculties, setFaculties] = useState<AdminFaculty[]>([]);
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [createDraft, setCreateDraft] = useState<CourseFormState>(emptyFormState());
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>(
    formInitialErrors()
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [editing, setEditing] = useState<AdminCourse | null>(null);
  const [editDraft, setEditDraft] = useState<CourseFormState>(emptyFormState());
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>(
    formInitialErrors()
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [busyStatusId, setBusyStatusId] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const createCodeId = useId();
  const createTitleId = useId();
  const createLevelId = useId();
  const createScopeId = useId();
  const createOwnerId = useId();
  const editCodeId = useId();
  const editTitleId = useId();
  const editLevelId = useId();
  const editScopeId = useId();
  const editOwnerId = useId();

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminCourses(), listAdminFaculties(), listAdminDepartments()])
      .then(([courseResult, facultyResult, departmentResult]) => {
        if (!cancelled) {
          setCourses(courseResult.data);
          setFaculties(facultyResult.data);
          setDepartments(departmentResult.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setListError(coursesErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function refresh(): void {
    setCourses(null);
    setListError(null);
    setReloadKey((key) => key + 1);
  }

  function validateCourseForm(draft: CourseFormState): Record<string, string> {
    const errors: Record<string, string> = {};
    const code = draft.code.trim();
    const title = draft.title.trim();
    if (code === "") {
      errors.code = "Please enter a course code.";
    } else if (code.length > MAX_COURSE_CODE_LENGTH) {
      errors.code = `The course code must be ${MAX_COURSE_CODE_LENGTH} characters or fewer.`;
    }
    if (title === "") {
      errors.title = "Please enter a course title.";
    } else if (title.length > MAX_TITLE_LENGTH) {
      errors.title = `The course title must be ${MAX_TITLE_LENGTH} characters or fewer.`;
    }
    if (!isPositiveId(draft.levelId)) {
      errors.levelId = "Please select a level.";
    }
    if (!isPositiveId(draft.ownerId)) {
      errors.ownerId =
        draft.scope === "FACULTY"
          ? "Please select a faculty."
          : "Please select a department.";
    }
    return errors;
  }

  function buildCourseCreateInput(draft: CourseFormState): AdminCourseCreateInput {
    return {
      courseCode: draft.code.trim(),
      title: draft.title.trim(),
      levelId: Number(draft.levelId),
      ...ownerPayload(draft.scope, draft.ownerId),
    };
  }

  function buildCourseUpdateInput(draft: CourseFormState): AdminCourseUpdateInput {
    return {
      courseCode: draft.code.trim(),
      title: draft.title.trim(),
      levelId: Number(draft.levelId),
      ...ownerPayload(draft.scope, draft.ownerId),
    };
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) {
      return;
    }

    setCreateError(null);
    const errors = validateCourseForm(createDraft);
    setCreateFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsCreating(true);
    try {
      await createAdminCourse(buildCourseCreateInput(createDraft));
      setCreateDraft(emptyFormState());
      setCreateFieldErrors(formInitialErrors());
      refresh();
    } catch (error) {
      setCreateError(courseWriteErrorMessage(error));
    } finally {
      setIsCreating(false);
    }
  }

  function startEdit(course: AdminCourse): void {
    setEditing(course);
    setEditDraft({
      code: course.courseCode,
      title: course.title,
      levelId: String(course.levelId),
      scope: course.scope,
      ownerId: String(course.scope === "FACULTY" ? course.facultyId : course.departmentId),
    });
    setEditFieldErrors(formInitialErrors());
    setEditError(null);
  }

  function cancelEdit(): void {
    setEditing(null);
    setEditDraft(emptyFormState());
    setEditFieldErrors(formInitialErrors());
    setEditError(null);
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null || isSavingEdit) {
      return;
    }

    setEditError(null);
    const errors = validateCourseForm(editDraft);
    setEditFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsSavingEdit(true);
    try {
      await updateAdminCourse(editing.id, buildCourseUpdateInput(editDraft));
      cancelEdit();
      refresh();
    } catch (error) {
      setEditError(courseWriteErrorMessage(error));
    } finally {
      setIsSavingEdit(false);
    }
  }

  async function handleStatusToggle(course: AdminCourse) {
    if (busyStatusId !== null) {
      return;
    }
    setStatusError(null);
    setBusyStatusId(course.id);
    try {
      await updateAdminCourse(course.id, {
        status: course.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
      });
      refresh();
    } catch (error) {
      setStatusError(courseWriteErrorMessage(error));
    } finally {
      setBusyStatusId(null);
    }
  }

  const ownerOptions =
    createDraft.scope === "FACULTY" ? faculties : departments;
  const editOwnerOptions = editDraft.scope === "FACULTY" ? faculties : departments;

  const loading = courses === null && listError === null;
  const total = courses?.length ?? 0;

  return (
    <main className="app-page admin-page">
      <header className="app-header admin-page-header">
        <div>
          <p className="admin-page-header__eyebrow">Administration</p>
          <h1>Course management</h1>
          <p className="app-header__sub">
            Courses students can register for, and which department owns each one.
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
          Loading courses…
        </p>
      ) : null}

      {courses !== null && courses.length === 0 ? (
        <div className="admin-empty">
          <p className="admin-empty__message" role="status">
            No courses found.
          </p>
          <p className="inline-status">
            Courses will appear here once they are created.
          </p>
        </div>
      ) : null}

      {courses !== null && courses.length > 0 ? (
        <>
          <p className="inline-status" role="status">
            {total === 1 ? "1 course" : `${total} courses`}
          </p>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Course</th>
                  <th scope="col">Level</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((course) => (
                  <tr key={course.id} className="admin-table__row">
                    <td>
                      <span className="admin-table__primary">
                        {course.courseCode}
                      </span>
                      <span className="admin-table__secondary">
                        {course.title}
                      </span>
                    </td>
                    <td>Level {course.levelName}</td>
                    <td>
                      {course.scope === "FACULTY" ? (
                        <>
                          <span className="admin-table__primary">
                            {course.facultyName}
                          </span>
                          <span className="admin-table__secondary">
                            Faculty-wide
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="admin-table__primary">
                            {course.departmentName}
                          </span>
                          <span className="admin-table__secondary">
                            Department
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      <span
                        className={`student-status ${courseStatusClass(course.status)}`}
                      >
                        {statusLabel(course.status)}
                      </span>
                    </td>
                    <td>
                      <div className="confirm-row">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => startEdit(course)}
                          disabled={editing !== null || busyStatusId !== null || isCreating}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleStatusToggle(course)}
                          disabled={
                            busyStatusId !== null || editing !== null || isCreating
                          }
                          aria-busy={busyStatusId === course.id}
                        >
                          {busyStatusId === course.id
                            ? course.status === "ACTIVE"
                              ? "Deactivating…"
                              : "Activating…"
                            : course.status === "ACTIVE"
                              ? "Deactivate"
                              : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {statusError !== null ? (
        <div className="resource-error">
          <FormError message={statusError} />
        </div>
      ) : null}

      <section className="app-card app-card--wide admin-compact-form-card" aria-labelledby="create-course-heading">
        <h2 id="create-course-heading">Add course</h2>
        <p className="note">
          A course belongs to exactly one owner: a faculty (faculty-wide course)
          or a department (department-specific course).
        </p>
        <form className="admin-inline-form admin-compact-form admin-compact-form--course" onSubmit={handleCreateSubmit} noValidate>
          <div className="field admin-inline-field">
            <label htmlFor={createCodeId} className="field__label">
              Course code
            </label>
            <input
              id={createCodeId}
              className="field__input"
              type="text"
              maxLength={MAX_COURSE_CODE_LENGTH}
              placeholder="e.g. CSC101"
              value={createDraft.code}
              onChange={(event) =>
                setCreateDraft((draft) => ({ ...draft, code: event.target.value }))
              }
              aria-invalid={createFieldErrors.code !== undefined || undefined}
            />
            {createFieldErrors.code !== undefined ? (
              <p className="field__error">{createFieldErrors.code}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={createTitleId} className="field__label">
              Course title
            </label>
            <input
              id={createTitleId}
              className="field__input"
              type="text"
              maxLength={MAX_TITLE_LENGTH}
              value={createDraft.title}
              onChange={(event) =>
                setCreateDraft((draft) => ({ ...draft, title: event.target.value }))
              }
              aria-invalid={createFieldErrors.title !== undefined || undefined}
            />
            {createFieldErrors.title !== undefined ? (
              <p className="field__error">{createFieldErrors.title}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={createLevelId} className="field__label">
              Level
            </label>
            <select
              id={createLevelId}
              className="field__input"
              value={createDraft.levelId}
              onChange={(event) =>
                setCreateDraft((draft) => ({
                  ...draft,
                  levelId: event.target.value,
                }))
              }
              aria-invalid={createFieldErrors.levelId !== undefined || undefined}
            >
              <option value="">Select a level</option>
              {ADMIN_LEVEL_OPTIONS.map((level) => (
                <option key={level.id} value={level.id}>
                  Level {level.name}
                </option>
              ))}
            </select>
            {createFieldErrors.levelId !== undefined ? (
              <p className="field__error">{createFieldErrors.levelId}</p>
            ) : null}
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={createScopeId} className="field__label">
              Owner type
            </label>
            <select
              id={createScopeId}
              className="field__input"
              value={createDraft.scope}
              onChange={(event) => {
                const scope = event.target.value as CourseScope;
                setCreateDraft((draft) => ({
                  ...draft,
                  scope,
                  ownerId: "",
                }));
                setCreateFieldErrors((errors) => {
                  if (!("ownerId" in errors)) {
                    return errors;
                  }
                  const next = { ...errors };
                  delete next.ownerId;
                  return next;
                });
              }}
            >
              <option value="FACULTY">Faculty-wide</option>
              <option value="DEPARTMENT">Department</option>
            </select>
          </div>
          <div className="field admin-inline-field">
            <label htmlFor={createOwnerId} className="field__label">
              {createDraft.scope === "FACULTY" ? "Faculty" : "Department"}
            </label>
            <select
              id={createOwnerId}
              className="field__input"
              value={createDraft.ownerId}
              onChange={(event) =>
                setCreateDraft((draft) => ({
                  ...draft,
                  ownerId: event.target.value,
                }))
              }
              aria-invalid={createFieldErrors.ownerId !== undefined || undefined}
            >
              <option value="">
                {createDraft.scope === "FACULTY"
                  ? "Select a faculty"
                  : "Select a department"}
              </option>
              {ownerOptions.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name} ({owner.code})
                </option>
              ))}
            </select>
            {createFieldErrors.ownerId !== undefined ? (
              <p className="field__error">{createFieldErrors.ownerId}</p>
            ) : null}
          </div>
          <button
            type="submit"
            className="auth-submit admin-submit"
            disabled={isCreating}
            aria-busy={isCreating}
          >
            {isCreating ? "Adding…" : "Add course"}
          </button>
        </form>
        {createError !== null ? (
          <div className="resource-error">
            <FormError message={createError} />
          </div>
        ) : null}
      </section>

      {editing !== null ? (
        <section className="app-card app-card--wide" aria-labelledby="edit-course-heading">
          <h2 id="edit-course-heading">Edit course</h2>
          <p className="note">
            Editing {editing.courseCode} ({editing.title}). Changing the owner
            type switches between a faculty-wide and a department-specific
            course.
          </p>
          <form className="admin-inline-form" onSubmit={handleEditSubmit} noValidate>
            <div className="field admin-inline-field">
              <label htmlFor={editCodeId} className="field__label">
                Course code
              </label>
              <input
                id={editCodeId}
                className="field__input"
                type="text"
                maxLength={MAX_COURSE_CODE_LENGTH}
                value={editDraft.code}
                onChange={(event) =>
                  setEditDraft((draft) => ({ ...draft, code: event.target.value }))
                }
                aria-invalid={editFieldErrors.code !== undefined || undefined}
              />
              {editFieldErrors.code !== undefined ? (
                <p className="field__error">{editFieldErrors.code}</p>
              ) : null}
            </div>
            <div className="field admin-inline-field">
              <label htmlFor={editTitleId} className="field__label">
                Course title
              </label>
              <input
                id={editTitleId}
                className="field__input"
                type="text"
                maxLength={MAX_TITLE_LENGTH}
                value={editDraft.title}
                onChange={(event) =>
                  setEditDraft((draft) => ({ ...draft, title: event.target.value }))
                }
                aria-invalid={editFieldErrors.title !== undefined || undefined}
              />
              {editFieldErrors.title !== undefined ? (
                <p className="field__error">{editFieldErrors.title}</p>
              ) : null}
            </div>
            <div className="field admin-inline-field">
              <label htmlFor={editLevelId} className="field__label">
                Level
              </label>
              <select
                id={editLevelId}
                className="field__input"
                value={editDraft.levelId}
                onChange={(event) =>
                  setEditDraft((draft) => ({
                    ...draft,
                    levelId: event.target.value,
                  }))
                }
                aria-invalid={editFieldErrors.levelId !== undefined || undefined}
              >
                <option value="">Select a level</option>
                {ADMIN_LEVEL_OPTIONS.map((level) => (
                  <option key={level.id} value={level.id}>
                    Level {level.name}
                  </option>
                ))}
              </select>
              {editFieldErrors.levelId !== undefined ? (
                <p className="field__error">{editFieldErrors.levelId}</p>
              ) : null}
            </div>
            <div className="field admin-inline-field">
              <label htmlFor={editScopeId} className="field__label">
                Owner type
              </label>
              <select
                id={editScopeId}
                className="field__input"
                value={editDraft.scope}
                onChange={(event) => {
                  const scope = event.target.value as CourseScope;
                  setEditDraft((draft) => ({ ...draft, scope, ownerId: "" }));
                  setEditFieldErrors((errors) => {
                    if (!("ownerId" in errors)) {
                      return errors;
                    }
                    const next = { ...errors };
                    delete next.ownerId;
                    return next;
                  });
                }}
              >
                <option value="FACULTY">Faculty-wide</option>
                <option value="DEPARTMENT">Department</option>
              </select>
            </div>
            <div className="field admin-inline-field">
              <label htmlFor={editOwnerId} className="field__label">
                {editDraft.scope === "FACULTY" ? "Faculty" : "Department"}
              </label>
              <select
                id={editOwnerId}
                className="field__input"
                value={editDraft.ownerId}
                onChange={(event) =>
                  setEditDraft((draft) => ({
                    ...draft,
                    ownerId: event.target.value,
                  }))
                }
                aria-invalid={editFieldErrors.ownerId !== undefined || undefined}
              >
                <option value="">
                  {editDraft.scope === "FACULTY"
                    ? "Select a faculty"
                    : "Select a department"}
                </option>
                {editOwnerOptions.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.name} ({owner.code})
                  </option>
                ))}
              </select>
              {editFieldErrors.ownerId !== undefined ? (
                <p className="field__error">{editFieldErrors.ownerId}</p>
              ) : null}
            </div>
            <div className="confirm-row">
              <button
                type="submit"
                className="auth-submit admin-submit"
                disabled={isSavingEdit}
                aria-busy={isSavingEdit}
              >
                {isSavingEdit ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={cancelEdit}
                disabled={isSavingEdit}
              >
                Cancel
              </button>
            </div>
          </form>
          {editError !== null ? (
            <div className="resource-error">
              <FormError message={editError} />
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}