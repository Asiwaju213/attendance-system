import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { verifyRegistration } from "../api/auth";
import type { RegistrationIdentityPreview } from "../api/auth";
import { ApiError } from "../api/client";
import { useAuth } from "../app/useAuth";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

type Step = "matric" | "password";

interface FieldErrors {
  matricNumber?: string;
  password?: string;
  confirmPassword?: string;
}

function formatMatricNumber(value: string): string {
  return value.trim().toUpperCase();
}

function matricErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "No pending registration found for this matric number. It may already be registered, inactive, or not exist.";
    }
    if (error.status === 400) {
      return "A valid matric number is required.";
    }
  }
  return "Unable to verify your matric number. Please try again later.";
}

function completionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && error.code === "INVALID_REGISTRATION_CHALLENGE") {
      return "This verification has expired or is invalid. Please verify your matric number again to continue.";
    }
    if (error.status === 409) {
      return "This account has already been registered.";
    }
    if (error.status === 404) {
      return "This student account is no longer available for registration.";
    }
    if (error.status === 400) {
      return "Your request could not be processed. Please check your details and try again.";
    }
  }
  return "Registration failed. Please try again later.";
}

function resetRegistrationState(
  setStep: (step: Step) => void,
  setIdentity: (identity: RegistrationIdentityPreview | null) => void,
  setPassword: (value: string) => void,
  setConfirmPassword: (value: string) => void,
  setFieldErrors: (errors: FieldErrors) => void,
  setFormError: (message: string | null) => void
): void {
  setStep("matric");
  setIdentity(null);
  setPassword("");
  setConfirmPassword("");
  setFieldErrors({});
  setFormError(null);
}

export function StudentRegisterPage() {
  const navigate = useNavigate();
  const { registerStudent } = useAuth();

  const [step, setStep] = useState<Step>("matric");
  const [matricNumber, setMatricNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [identity, setIdentity] = useState<RegistrationIdentityPreview | null>(null);

  async function handleMatricSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const normalized = formatMatricNumber(matricNumber);
    if (normalized === "") {
      setFieldErrors({ matricNumber: "Matric number is required." });
      return;
    }

    setIsSubmitting(true);
    setFieldErrors({});

    try {
      const data = await verifyRegistration(normalized);
      if (data.challengeToken === "") {
        throw new ApiError(400, "INVALID_REQUEST");
      }
      setIdentity(data);
      setStep("password");
    } catch (error) {
      setFormError(matricErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleRetry() {
    resetRegistrationState(
      setStep,
      setIdentity,
      setPassword,
      setConfirmPassword,
      setFieldErrors,
      setFormError
    );
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors: FieldErrors = {};

    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      errors.password = `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match.";
    }

    if (errors.password || errors.confirmPassword) {
      setFieldErrors(errors);
      return;
    }

    if (!identity) {
      setFormError("This verification has expired or is invalid. Please verify your matric number again.");
      resetRegistrationState(
        setStep,
        setIdentity,
        setPassword,
        setConfirmPassword,
        setFieldErrors,
        () => {}
      );
      return;
    }

    setIsSubmitting(true);
    setFieldErrors({});

    try {
      await registerStudent(identity.challengeToken, password);
      navigate("/app/student", { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_REGISTRATION_CHALLENGE") {
        setFormError(completionErrorMessage(error));
        resetRegistrationState(
          setStep,
          setIdentity,
          setPassword,
          setConfirmPassword,
          setFieldErrors,
          () => {}
        );
      } else {
        setFormError(completionErrorMessage(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Student Registration"
      eyebrow="Account activation"
      description="Activate your student account to register for courses and mark attendance."
      subtitle={
        step === "matric"
          ? "Enter the matric number on your admission letter."
          : "Check the details below, then choose a password."
      }
      footer={
        <>
          <Link to="/login">Back to student login</Link>
        </>
      }
    >
      <ol className="auth-steps" aria-label="Registration progress">
        <li
          className={`auth-steps__step ${
            step === "matric" ? "auth-steps__step--current" : "auth-steps__step--complete"
          }`}
          aria-current={step === "matric" ? "step" : undefined}
        >
          <span className="auth-steps__index" aria-hidden="true">
            1
          </span>
          <span className="auth-steps__label">Verify identity</span>
        </li>
        <li
          className={`auth-steps__step ${
            step === "password" ? "auth-steps__step--current" : ""
          }`}
          aria-current={step === "password" ? "step" : undefined}
        >
          <span className="auth-steps__index" aria-hidden="true">
            2
          </span>
          <span className="auth-steps__label">Create password</span>
        </li>
      </ol>
      {step === "matric" ? (
        <form onSubmit={handleMatricSubmit} noValidate>
          {formError !== null ? <FormError message={formError} /> : null}
          <Field
            label="Matric Number"
            name="matricNumber"
            type="text"
            autoComplete="username"
            value={matricNumber}
            onChange={(event) => setMatricNumber(event.target.value)}
            error={fieldErrors.matricNumber}
            disabled={isSubmitting}
            autoFocus
          />
          <button
            type="submit"
            className="auth-submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? "Verifying…" : "Continue"}
          </button>
        </form>
      ) : (
        identity && (
          <form onSubmit={handlePasswordSubmit} noValidate>
            {formError !== null ? <FormError message={formError} /> : null}
            <div className="identity-preview">
              <p className="identity-preview__label">Verified details</p>
              <dl className="identity-preview__details">
                <dt>Name</dt>
                <dd>{identity.name}</dd>
                <dt>Matric Number</dt>
                <dd>{identity.matricNumber}</dd>
                <dt>Department</dt>
                <dd>
                  {identity.department.name} ({identity.department.code})
                </dd>
                <dt>Level</dt>
                <dd>Level {identity.level.name}</dd>
              </dl>
            </div>
            <p className="note">These details come from the registry and cannot be changed here.</p>
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              disabled={isSubmitting}
              autoFocus
            />
            <Field
              label="Confirm Password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              error={fieldErrors.confirmPassword}
              disabled={isSubmitting}
            />
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleRetry}
                disabled={isSubmitting}
              >
                Request a new verification
              </button>
              <button
                type="submit"
                className="auth-submit"
                disabled={isSubmitting}
                aria-busy={isSubmitting}
              >
                {isSubmitting ? "Registering…" : "Complete registration"}
              </button>
            </div>
          </form>
        )
      )}
    </AuthShell>
  );
}