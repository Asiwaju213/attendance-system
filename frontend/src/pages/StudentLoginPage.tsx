import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { errorMessageForSubmit } from "../app/errors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { getStudentDeviceBinding } from "../api/auth";
import type { StudentLoginResult } from "../api/auth";

interface FieldErrors {
  matricNumber?: string;
  password?: string;
}

/**
 * Why a sign-in attempt could not start a session even though the password was correct.
 *
 * This is deliberately not a credential failure. The student proved who they are; what they are
 * being told is that this phone cannot be enrolled while another device holds the account, and
 * that an administrator has to release it first.
 *
 * The message names no credential id, WebAuthn id, student id or device id, and reveals nothing
 * beyond the single fact the student needs in order to know what to do next.
 */
const DEVICE_ALREADY_ENROLLED_MESSAGE =
  "Another device is already enrolled for this account, so this phone cannot be enrolled yet. " +
  "Please ask an administrator to reset the enrolled device, then sign in again to register this one.";

/**
 * The message for the first-device path.
 *
 * The backend issues a short-lived, single-use enrollment grant here rather than a session, and
 * the grant authorizes the device enrollment ceremony and nothing else. That is why the student
 * is sent to the enrollment page instead of the dashboard.
 */
const ENROLLMENT_REQUIRED_MESSAGE =
  "Your details were accepted. Register a passkey on this device to finish signing in.";

export function StudentLoginPage() {
  const { loginStudent } = useAuth();
  const navigate = useNavigate();

  const [hasDeviceBinding, setHasDeviceBinding] = useState(false);
  const [isCheckingDeviceBinding, setIsCheckingDeviceBinding] = useState(true);

  const [matricNumber, setMatricNumber] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getStudentDeviceBinding()
      .then((response) => {
        if (cancelled) return;
        setHasDeviceBinding(response.hasDeviceBinding);
      })
      .catch(() => {
        if (cancelled) return;
        setHasDeviceBinding(false);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingDeviceBinding(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Act on the backend's decision.
   *
   * The three outcomes are genuinely different and only one of them is a signed-in session:
   *
   *   - `authenticated` is the existing bound-device path, unchanged.
   *   - `enrollmentRequired` means the password was right, the account has no active device, and
   *     a scoped enrollment grant was issued. The student goes to the enrollment page; navigating
   *     to the dashboard here would be pointless, because no `oou_session` exists yet.
   *   - `deviceAlreadyEnrolled` is a refusal, not a login failure, and is explained on this page.
   */
  function applyLoginResult(result: StudentLoginResult): boolean {
    if (result.outcome === "authenticated") {
      navigate(homePathForRole(result.user.role), { replace: true });
      return true;
    }

    if (result.outcome === "enrollmentRequired") {
      setNotice(ENROLLMENT_REQUIRED_MESSAGE);
      navigate("/enroll-device", { replace: true });
      return true;
    }

    setNotice(DEVICE_ALREADY_ENROLLED_MESSAGE);
    setFormError(null);
    setPassword("");
    return false;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setNotice(null);

    const errors: FieldErrors = {};

    // The bound-device view collects no matric number: the device-binding cookie identifies the
    // student, so `POST /auth/student/login` reads only the password on that path. Requiring a
    // matric number here would always fail validation and never issue the request.
    const requiresMatricNumber = !hasDeviceBinding;

    if (requiresMatricNumber && matricNumber.trim() === "") {
      errors.matricNumber = "Matric number is required.";
    }
    if (password === "") {
      errors.password = "Password is required.";
    }
    setFieldErrors(errors);

    if (errors.matricNumber !== undefined || errors.password !== undefined) {
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await loginStudent(matricNumber.trim(), password);
      const handled = applyLoginResult(result);
      if (!handled) {
        setIsSubmitting(false);
      }
    } catch (error) {
      setFormError(errorMessageForSubmit(error));
      setIsSubmitting(false);
    }
  }

  // Loading state while checking for device binding
  if (isCheckingDeviceBinding) {
    return (
      <AuthShell
        title="Student Login"
        eyebrow="Student access"
        description="Sign in to register for courses, mark attendance, and check your attendance history."
        subtitle="Checking your device…"
      >
        <div className="device-status-section__loading" role="status" aria-live="polite">
          <div className="device-enrollment-pending__spinner" aria-hidden="true" />
          <p className="device-enrollment-pending__message">Loading…</p>
        </div>
      </AuthShell>
    );
  }

  // A device-binding cookie identifies the student, so this view collects only the password.
  // WebAuthn stays infrastructure here: there is deliberately no separate passkey button, because
  // the browser's own credential handling is what makes the bound-device path work.
  const showDeviceBindingView = hasDeviceBinding;

  return (
    <AuthShell
      title="Student Login"
      eyebrow="Student access"
      description="Sign in to register for courses, mark attendance, and check your attendance history."
      subtitle={
        showDeviceBindingView
          ? "Confirm your password to continue."
          : "Enter your matric number and password."
      }
      footer={<Link to="/register">New student? Register here</Link>}
    >
      {notice !== null ? (
        <div className="resource-error auth-device-error" role="alert">
          <FormError message={notice} />
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        {formError !== null ? <FormError message={formError} /> : null}

        {showDeviceBindingView ? null : (
          <Field
            label="Matric Number"
            name="matricNumber"
            type="text"
            autoComplete="username"
            value={matricNumber}
            onChange={(event) => setMatricNumber(event.target.value)}
            error={fieldErrors.matricNumber}
            autoFocus
          />
        )}

        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          autoFocus={showDeviceBindingView}
        />

        <button
          type="submit"
          className="auth-submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {!showDeviceBindingView ? (
        <p className="device-enrollment-guidance device-enrollment-guidance--note">
          On a new phone, your password takes you to a one-time passkey
          registration for that device.
        </p>
      ) : null}
    </AuthShell>
  );
}