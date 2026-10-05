import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { ApiError } from "../api/client";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";

const MIN_PASSWORD_LENGTH = 8;

interface FieldErrors {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

function submitErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "That current password is not correct. Please try again.";
    }
    if (error.status === 400) {
      return "Check the new password and make sure both entries match.";
    }
    if (error.status === 409) {
      return "This account no longer has a pending password change. Please sign in again.";
    }
    if (error.status === 403) {
      return "This account cannot change its password here.";
    }
  }
  return "The password could not be changed. Please try again.";
}

export function LecturerChangePasswordPage() {
  const { changePassword, logout } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (currentPassword === "") {
      errors.currentPassword = "Enter your temporary password.";
    }
    if (newPassword === "") {
      errors.newPassword = "Enter a new password.";
    } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
      errors.newPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (newPassword === currentPassword) {
      errors.newPassword = "The new password must be different from the temporary one.";
    }
    if (confirmPassword === "") {
      errors.confirmPassword = "Type the new password again.";
    } else if (confirmPassword !== newPassword) {
      errors.confirmPassword = "The two passwords do not match.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setFormError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      // The provider re-reads /auth/me afterwards, so this resolves with the flag already
      // cleared and the app continues into the normal lecturer dashboard.
      const user = await changePassword(currentPassword, newPassword, confirmPassword);
      navigate(user === null ? "/staff/lecturer/login" : homePathForRole("LECTURER"), {
        replace: true,
      });
    } catch (error) {
      setFormError(submitErrorMessage(error));
      setIsSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    try {
      await logout();
      navigate("/staff/lecturer/login", { replace: true });
    } catch {
      setIsSigningOut(false);
      setFormError("Signing out failed. Please try again.");
    }
  }

  return (
    <AuthShell
      title="Change your password"
      eyebrow="First sign-in"
      description="Your attendance workspace is available once your temporary password has been replaced."
      subtitle="Choose a new password for your staff account. You will sign in with it from now on."
      footer={
        <button
          type="button"
          className="secondary-button"
          onClick={handleSignOut}
          disabled={isSubmitting || isSigningOut}
        >
          {isSigningOut ? "Signing out…" : "Sign out instead"}
        </button>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        {formError !== null ? <FormError message={formError} /> : null}
        <Field
          label="Temporary password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          error={fieldErrors.currentPassword}
        />
        <Field
          label="New password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          error={fieldErrors.newPassword}
        />
        <Field
          label="Confirm new password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          error={fieldErrors.confirmPassword}
        />
        <button
          type="submit"
          className="auth-submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? "Saving…" : "Change password"}
        </button>
        <p className="note">
          Your account stays limited to this page until the password is changed.
        </p>
      </form>
    </AuthShell>
  );
}
