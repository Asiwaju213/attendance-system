import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { errorMessageForSubmit } from "../app/errors";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";

interface FieldErrors {
  staffId?: string;
  password?: string;
}

export function LecturerLoginPage() {
  const { loginLecturer } = useAuth();
  const navigate = useNavigate();

  const [staffId, setStaffId] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors: FieldErrors = {};
    if (staffId.trim() === "") {
      errors.staffId = "Staff ID is required.";
    }
    if (password === "") {
      errors.password = "Password is required.";
    }
    setFieldErrors(errors);

    if (errors.staffId !== undefined || errors.password !== undefined) {
      return;
    }

    setIsSubmitting(true);
    try {
      const user = await loginLecturer(staffId.trim(), password);
      navigate(homePathForRole(user.role), { replace: true });
    } catch (error) {
      setFormError(errorMessageForSubmit(error));
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Lecturer Login"
      subtitle="Sign in with your staff ID to continue."
      footer={
        <>
          <Link to="/staff/login">Back to staff login</Link>
          <Link to="/login">Student login</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        {formError !== null ? <FormError message={formError} /> : null}
        <Field
          label="Staff ID"
          name="staffId"
          type="text"
          autoComplete="username"
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
          error={fieldErrors.staffId}
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
    </AuthShell>
  );
}