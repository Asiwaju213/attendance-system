import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  getEligibleCourses,
  listMyCourseRegistrations,
  registerForCourses,
} from "../api/studentCourseRegistration";
import { courseRegistrationErrorMessage } from "../app/courseRegistrationErrors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import type {
  CourseScope,
  RegistrationAcademicSession,
  RegistrationDepartment,
  RegistrationFaculty,
  StudentCourseRegistration,
  StudentOfferingCourse,
} from "../types/studentCourseRegistration";

function toMyCourse(
  course: StudentOfferingCourse,
  academicSession: RegistrationAcademicSession
): StudentCourseRegistration {
  return {
    offeringId: course.offeringId,
    courseId: course.courseId,
    courseCode: course.courseCode,
    title: course.title,
    level: course.level,
    scope: course.scope,
    department: course.department,
    faculty: course.faculty,
    semester: course.semester,
    academicSession,
    offeringStatus: "OPEN",
    registrationStatus: "ENROLLED",
    lecturers: course.lecturers,
  };
}

function scopeLabelFor(course: {
  scope: CourseScope;
  department: RegistrationDepartment | null;
  faculty: RegistrationFaculty | null;
}): string {
  return course.scope === "FACULTY"
    ? course.faculty?.name ?? "Faculty"
    : course.department?.name ?? "Department";
}

function lecturerLabelFor(lecturers: Array<{ name: string }>): string {
  return lecturers.map((lecturer) => lecturer.name).join(", ");
}

export function StudentCourseRegistrationPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [academicSession, setAcademicSession] =
    useState<RegistrationAcademicSession | null>(null);
  const [courses, setCourses] = useState<StudentOfferingCourse[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [registrations, setRegistrations] = useState<
    StudentCourseRegistration[] | null
  >(null);
  const [registrationsError, setRegistrationsError] = useState<string | null>(
    null
  );
  const [registrationsReloadKey, setRegistrationsReloadKey] = useState(0);

  const [enrollingIds, setEnrollingIds] = useState<ReadonlySet<number>>(
    new Set()
  );
  const [enrollErrors, setEnrollErrors] = useState<Record<number, string>>({});

  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const inflightReloadKeyRef = useRef<number | null>(null);
  const inflightPromiseRef =
    useRef<Promise<Awaited<ReturnType<typeof getEligibleCourses>>> | null>(null);

  const inflightRegsKeyRef = useRef<number | null>(null);
  const inflightRegsPromiseRef =
    useRef<
      Promise<Awaited<ReturnType<typeof listMyCourseRegistrations>>>
    >(null);

  useEffect(() => {
    // A single in-flight request is shared across rendered views of this page
    // (including the strict-mode double effect in development), so navigating
    // to or rendering the same page never fires a second request. The Retry
    // button bumps reloadKey, which invalidates the shared request.
    const reloadKeyChanged = inflightReloadKeyRef.current !== reloadKey;
    if (reloadKeyChanged) {
      inflightReloadKeyRef.current = reloadKey;
      inflightPromiseRef.current = getEligibleCourses();
    }

    let active = true;
    const request = inflightPromiseRef.current;
    if (request === null) {
      return;
    }

    request
      .then((result) => {
        if (!active) {
          return;
        }
        if (
          result.data === null ||
          typeof result.data !== "object" ||
          !Array.isArray(result.data.courses)
        ) {
          throw new TypeError("Unexpected course registration response.");
        }
        setAcademicSession(result.data.academicSession ?? null);
        setCourses(result.data.courses);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) {
          setCourses(null);
          setAcademicSession(null);
          setLoadError(courseRegistrationErrorMessage(error));
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    const reloadKeyChanged = inflightRegsKeyRef.current !== registrationsReloadKey;
    if (reloadKeyChanged) {
      inflightRegsKeyRef.current = registrationsReloadKey;
      inflightRegsPromiseRef.current = listMyCourseRegistrations();
    }

    let active = true;
    const request = inflightRegsPromiseRef.current;
    if (request === null) {
      return;
    }

    request
      .then((result) => {
        if (!active) {
          return;
        }
        if (
          result.data === null ||
          typeof result.data !== "object" ||
          !Array.isArray(result.data.registrations)
        ) {
          throw new TypeError("Unexpected course registrations response.");
        }
        setRegistrations(result.data.registrations);
        setRegistrationsError(null);
      })
      .catch((error: unknown) => {
        if (active) {
          setRegistrations(null);
          setRegistrationsError(courseRegistrationErrorMessage(error));
        }
      });

    return () => {
      active = false;
    };
  }, [registrationsReloadKey]);

  async function handleEnroll(offeringId: number): Promise<void> {
    if (enrollingIds.has(offeringId)) {
      return;
    }
    setEnrollingIds((current) => new Set(current).add(offeringId));
    setEnrollErrors((current) => {
      if (!(offeringId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[offeringId];
      return next;
    });
    try {
      const result = await registerForCourses([offeringId]);
      const completedIds = new Set(
        [...result.data.registered, ...result.data.alreadyRegistered].map(
          (item) => item.offeringId
        )
      );
      setCourses((current) =>
        current === null
          ? current
          : current.map((course) =>
              completedIds.has(course.offeringId)
                ? { ...course, isRegistered: true }
                : course
            )
      );
    } catch (error: unknown) {
      setEnrollErrors((current) => ({
        ...current,
        [offeringId]: courseRegistrationErrorMessage(error),
      }));
    } finally {
      setEnrollingIds((current) => {
        const next = new Set(current);
        next.delete(offeringId);
        return next;
      });
    }
  }

  async function handleLogout() {
    if (user === null || isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate("/login", { replace: true });
  }

  function handleRetry() {
    setLoadError(null);
    setReloadKey((key) => key + 1);
    setRegistrationsError(null);
    setRegistrationsReloadKey((key) => key + 1);
  }

  function handleRegistrationsRetry() {
    setRegistrationsError(null);
    setRegistrationsReloadKey((key) => key + 1);
  }

  if (user === null) {
    return (
      <main className="loading-page" role="status">
        Loading…
      </main>
    );
  }

  const loading = courses === null && loadError === null;

  const availableCourses = (courses ?? []).filter(
    (course) => !course.isRegistered
  );

  const myCoursesByOffering = new Map<number, StudentCourseRegistration>();
  for (const registration of registrations ?? []) {
    myCoursesByOffering.set(registration.offeringId, registration);
  }
  if (academicSession !== null) {
    for (const course of courses ?? []) {
      if (course.isRegistered && !myCoursesByOffering.has(course.offeringId)) {
        myCoursesByOffering.set(
          course.offeringId,
          toMyCourse(course, academicSession)
        );
      }
    }
  }
  const myCourses = Array.from(myCoursesByOffering.values()).sort((a, b) =>
    a.courseCode.localeCompare(b.courseCode)
  );

  function renderCourseMeta(
    level: number,
    semesterName: string,
    scope: CourseScope,
    scopeLabel: string,
    lecturerNames: string
  ) {
    return (
      <dl className="registration-meta registration-course-meta">
        <div>
          <dt>Level</dt>
          <dd>Level {level}</dd>
        </div>
        <div>
          <dt>Semester</dt>
          <dd>{semesterName}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {scope === "FACULTY" ? "Faculty" : "Department"} · {scopeLabel}
          </dd>
        </div>
        <div>
          <dt>Lecturer{lecturerNames.includes(",") ? "s" : ""}</dt>
          <dd>{lecturerNames === "" ? "Not assigned" : lecturerNames}</dd>
        </div>
      </dl>
    );
  }

  return (
    <main className="app-page registration-page">
      <header className="app-header registration-page-header">
        <div className="registration-page-header__copy">
          <p className="registration-page-header__eyebrow">Student registration</p>
          <h1>Course registration</h1>
          <p className="app-header__sub">
            {academicSession !== null
              ? `Courses offered in ${academicSession.name}.`
              : "Courses currently open for registration."}
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Student navigation">
          <Link to={homePathForRole("STUDENT")}>Home</Link>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </header>

      {loading ? (
        <section
          className="app-card app-card--wide registration-state-card registration-state-card--loading"
          aria-label="Course registration"
        >
          <div className="registration-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="inline-status" role="status">
            Loading course registration…
          </p>
        </section>
      ) : null}

      {loadError !== null ? (
        <section
          className="app-card app-card--wide registration-state-card registration-state-card--error"
          aria-label="Course registration"
        >
          <p className="registration-state-card__title">Unable to load courses</p>
          <div className="resource-error">
            <FormError message={loadError} />
            <button
              type="button"
              className="secondary-button"
              onClick={handleRetry}
              aria-busy={loading}
            >
              Retry
            </button>
          </div>
        </section>
      ) : null}

      {loadError === null && courses !== null ? (
        <section
          className="registration-section"
          aria-labelledby="available-courses-heading"
        >
          <div className="registration-section__header">
            <h2 id="available-courses-heading" className="registration-section__title">
              Available courses
            </h2>
            <p className="registration-section__description">
              Courses you can register for now.
            </p>
          </div>
          {availableCourses.length === 0 ? (
            <section
              className="app-card app-card--wide registration-state-card registration-state-card--empty"
              aria-label="Course registration"
            >
              <p className="registration-state-card__title">No courses available</p>
              <p className="inline-status" role="status">
                No courses are currently available for registration.
              </p>
            </section>
          ) : (
            availableCourses.map((course) => {
              const headingId = `available-course-${course.offeringId}`;
              const enrolling = enrollingIds.has(course.offeringId);
              const enrollError = enrollErrors[course.offeringId] ?? null;
              const lecturerNames = lecturerLabelFor(course.lecturers);

              return (
                <section
                  key={course.offeringId}
                  className="app-card app-card--wide registration-course-card registration-course-card--available"
                  aria-labelledby={headingId}
                >
                  <h2
                    id={headingId}
                    className="registration-course-card__title"
                  >
                    <span className="registration-course-card__code">
                      {course.courseCode}
                    </span>
                    <span className="registration-course-card__divider" aria-hidden="true">{" · "}</span>
                    <span className="registration-course-card__name">
                      {course.title}
                    </span>
                  </h2>

                  {renderCourseMeta(
                    course.level,
                    course.semester.name,
                    course.scope,
                    scopeLabelFor(course),
                    lecturerNames
                  )}

                  {enrollError !== null ? (
                    <FormError message={enrollError} />
                  ) : null}

                  <div className="registration-actions">
                    <button
                      type="button"
                      className="secondary-button registration-enroll-button"
                      onClick={() => {
                        void handleEnroll(course.offeringId);
                      }}
                      disabled={enrolling}
                      aria-busy={enrolling}
                    >
                      {enrolling ? "Enrolling…" : "Enroll"}
                    </button>
                  </div>
                </section>
              );
            })
          )}
        </section>
      ) : null}

      <section
        className="registration-section registration-section--my-courses"
        aria-labelledby="my-courses-heading"
      >
        <div className="registration-section__header">
          <h2 id="my-courses-heading" className="registration-section__title">
            My courses
          </h2>
          <p className="registration-section__description">
            Courses you are enrolled in.
          </p>
        </div>
        {myCourses.length === 0 ? (
          registrations !== null && registrationsError === null ? (
            <section
              className="app-card app-card--wide registration-state-card registration-state-card--empty"
              aria-label="My courses"
            >
              <p className="registration-state-card__title">No courses yet</p>
              <p className="inline-status" role="status">
                You are not enrolled in any courses yet.
              </p>
            </section>
          ) : registrationsError === null ? (
            <section
              className="app-card app-card--wide registration-state-card registration-state-card--loading"
              aria-label="My courses"
            >
              <p className="inline-status" role="status">Loading your courses…</p>
            </section>
          ) : null
        ) : (
          myCourses.map((row) => {
            const headingId = `my-course-${row.offeringId}`;
            const lecturerNames = lecturerLabelFor(row.lecturers);

            return (
              <section
                key={row.offeringId}
                className="app-card app-card--wide registration-course-card registration-course-card--enrolled"
                aria-labelledby={headingId}
              >
                <h2 id={headingId} className="registration-course-card__title">
                  <span className="registration-course-card__code">
                    {row.courseCode}
                  </span>
                  <span className="registration-course-card__divider" aria-hidden="true">{" · "}</span>
                  <span className="registration-course-card__name">
                    {row.title}
                  </span>
                </h2>

                {renderCourseMeta(
                  row.level,
                  row.semester.name,
                  row.scope,
                  scopeLabelFor(row),
                  lecturerNames
                )}

                <div className="registration-actions">
                  <span className="registration-status registration-status--enrolled">
                    Enrolled
                  </span>
                </div>
              </section>
            );
          })
        )}

        {registrationsError !== null ? (
          <div className="resource-error registration-section-error">
            <FormError message={registrationsError} />
            <button
              type="button"
              className="secondary-button"
              onClick={handleRegistrationsRetry}
            >
              Retry
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}