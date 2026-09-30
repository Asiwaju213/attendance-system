import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { errorMessageForSubmit } from "../app/errors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { ApiError } from "../api/client";
import { startStudentDeviceLogin } from "../api/auth";
import {
  getDeviceAssertion,
  isWebAuthnSupported,
  WebAuthnUnsupportedError,
} from "../lib/webauthn";
import type { AuthenticationResponseJSON } from "../types/webauthn";
import {
  getStudentDeviceBinding,
} from "../api/auth";

interface FieldErrors {
  matricNumber?: string;
  password?: string;
}

/**
 * The usernameless ceremony finishes the device proof first and the password is the second
 * factor, so the page has two stages: pick a method, then supply the password.
 *
 * The ceremony material (binding token + assertion) is held in ordinary component state for the
 * duration of this attempt only. It is never written to localStorage, sessionStorage, a cookie,
 * the URL, or any other store, and it is discarded whenever the student changes method.
 */
type LoginStage = "method" | "password";

interface PendingDeviceCeremony {
  bindingToken: string;
  assertion: AuthenticationResponseJSON;
}

/**
 * Messages for the device sign-in path.
 *
 * The backend answers every credential/account failure with one generic
 * `401 INVALID_CREDENTIALS`, and that property is preserved here: nothing below distinguishes
 * an unknown credential, a revoked device, a non-discoverable credential, an inactive account or
 * a wrong password, because the response does not distinguish them either.
 */
function deviceSignInErrorMessage(error: unknown): string {
  if (error instanceof WebAuthnUnsupportedError) {
    return "Device sign-in is not available in this browser or on this device. You can sign in with your matric number instead.";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  ) {
    return "Device sign-in was cancelled.";
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Sign-in details could not be verified. Please try again.";
    }
    if (error.status === 429) {
      return "Too many attempts. Please wait a few minutes and try again.";
    }
    if (error.status === 400) {
      return "That sign-in attempt could not be completed. Please try again.";
    }
  }
  return "Unable to sign in right now. Please try again later.";
}

export function StudentLoginPage() {
  const { loginStudent, loginStudentWithDevice } = useAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<LoginStage>("method");
  const [ceremony, setCeremony] = useState<PendingDeviceCeremony | null>(null);
  const [hasDeviceBinding, setHasDeviceBinding] = useState(false);
  const [isCheckingDeviceBinding, setIsCheckingDeviceBinding] = useState(true);

  const [isStartingDeviceLogin, setIsStartingDeviceLogin] = useState(false);
  const [isVerifyingDevice, setIsVerifyingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [matricNumber, setMatricNumber] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDeviceBusy = isStartingDeviceLogin || isVerifyingDevice;

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

  /** Abandon the in-flight ceremony and return to the method choice. */
  function resetDeviceCeremony() {
    setStage("method");
    setCeremony(null);
    setPassword("");
    setDeviceError(null);
    setFieldErrors({});
    setFormError(null);
  }

  function showDeviceSignIn() {
    setStage("method");
    setDeviceError(null);
  }

  /**
   * Run the usernameless WebAuthn ceremony.
   *
   * The browser assertion is the only identity input sent: no matric number, student id, user
   * id or role is included, and the server has not identified anyone yet at this point.
   */
  async function handleDeviceSignIn() {
    if (isDeviceBusy) {
      return;
    }

    setDeviceError(null);

    if (!isWebAuthnSupported()) {
      setDeviceError(deviceSignInErrorMessage(new WebAuthnUnsupportedError()));
      return;
    }

    setIsStartingDeviceLogin(true);
    try {
      const { options, bindingToken } = await startStudentDeviceLogin();
      const assertion = await getDeviceAssertion(options);

      // The device half is proven. Hold the result in memory and ask for the password, which is
      // the second factor.
      setCeremony({ bindingToken, assertion });
      setPassword("");
      setStage("password");
    } catch (error) {
      setDeviceError(deviceSignInErrorMessage(error));
    } finally {
      setIsStartingDeviceLogin(false);
    }
  }

  /**
   * Complete device sign-in with the password.
   *
   * A wrong password deliberately leaves the server challenge unconsumed, so the student can
   * correct a typo and resubmit without another passkey prompt. `handleRestartDeviceSignIn`
   * exists for the case where the ceremony is no longer usable, such as an expired challenge.
   */
  async function handleDevicePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeviceError(null);

    if (ceremony === null || isDeviceBusy) {
      return;
    }

    if (password === "") {
      setFieldErrors({ password: "Password is required." });
      return;
    }
    setFieldErrors({});

    setIsVerifyingDevice(true);
    try {
      const user = await loginStudentWithDevice(
        ceremony.bindingToken,
        ceremony.assertion,
        password
      );
      // Drop the ceremony material as soon as it is spent.
      setCeremony(null);
      navigate(homePathForRole(user.role), { replace: true });
    } catch (error) {
      setDeviceError(deviceSignInErrorMessage(error));
      setPassword("");
    } finally {
      setIsVerifyingDevice(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

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
      const user = await loginStudent(matricNumber.trim(), password);
      navigate(homePathForRole(user.role), { replace: true });
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
        eyebrow="Student Access"
        description="Sign in to manage course registration, attendance, and device enrollment."
        subtitle="Checking your device…"
      >
        <div className="device-status-section__loading" role="status" aria-live="polite">
          <div className="device-enrollment-pending__spinner" aria-hidden="true" />
          <p className="device-enrollment-pending__message">Loading…</p>
        </div>
      </AuthShell>
    );
  }

  // Stage: password (device sign-in second step - only reached via explicit "Use passkey instead")
  if (stage === "password") {
    return (
      <AuthShell
        title="Student Login"
        eyebrow="Student Access"
        description="Sign in to manage course registration, attendance, and device enrollment."
        subtitle="Your device has identified your account. Enter your password to finish signing in."
        footer={<Link to="/register">New student? Register here</Link>}
      >
        <div className="auth-device-confirmed">
          <p className="auth-device-confirmed__label">Device verified</p>
          <p className="auth-device-confirmed__text">
            This device matched your registered passkey. Your password is required to complete
            sign-in.
          </p>
        </div>

        {deviceError !== null ? (
          <div className="resource-error auth-device-error">
            <FormError message={deviceError} />
          </div>
        ) : null}

        <form onSubmit={handleDevicePasswordSubmit} noValidate>
          <Field
            label="Password"
            name="devicePassword"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
            disabled={isVerifyingDevice}
            autoFocus
          />
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={resetDeviceCeremony}
              disabled={isVerifyingDevice}
            >
              Start over
            </button>
            <button
              type="submit"
              className="auth-submit"
              disabled={isVerifyingDevice}
              aria-busy={isVerifyingDevice}
            >
              {isVerifyingDevice ? "Signing in…" : "Sign In"}
            </button>
          </div>
        </form>

        <p className="auth-panel__hint">
          <button
            type="button"
            className="auth-link-button"
            onClick={resetDeviceCeremony}
            disabled={isVerifyingDevice}
          >
            Use matric number instead
          </button>
        </p>
      </AuthShell>
    );
  }

  // Stage: method - decide what to show based on device binding
  const showDeviceBindingView = hasDeviceBinding;

  return (
    <AuthShell
      title="Student Login"
      eyebrow="Student Access"
      description="Sign in to manage course registration, attendance, and device enrollment."
      subtitle={showDeviceBindingView
        ? "Welcome back"
        : "Sign in with your matric number and password, or use your registered device."}
      footer={<Link to="/register">New student? Register here</Link>}
    >
      {/* Device binding view - password only (no matric number, no account switching, no passkey option) */}
      {showDeviceBindingView ? (
        <>
          <form onSubmit={handleSubmit} noValidate>
            {formError !== null ? <FormError message={formError} /> : null}
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              autoFocus
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
        </>
      ) : (
        <>
          {/* Full matric + password form (no device binding) */}
          <form onSubmit={handleSubmit} noValidate>
            {formError !== null ? <FormError message={formError} /> : null}
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
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
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

          <p className="auth-panel__hint">
            <button
              type="button"
              className="auth-link-button"
              onClick={showDeviceSignIn}
              disabled={isSubmitting}
            >
              Use passkey instead
            </button>
          </p>

          {/* Device sign-in (WebAuthn) - fallback option */}
          <div className="auth-device-signin">
            <button
              type="button"
              className="auth-submit auth-device-signin__button"
              onClick={handleDeviceSignIn}
              disabled={isDeviceBusy}
              aria-busy={isStartingDeviceLogin}
            >
              {isStartingDeviceLogin ? "Waiting for your device…" : "Sign in with this device"}
            </button>
            <p className="auth-device-signin__note">
              Confirm with the passkey already registered on this device. You will be asked for
              your password next.
            </p>
          </div>

          {deviceError !== null ? (
            <div className="resource-error auth-device-error">
              <FormError message={deviceError} />
            </div>
          ) : null}
        </>
      )}
    </AuthShell>
  );
}