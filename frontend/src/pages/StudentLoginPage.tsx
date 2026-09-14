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
  matricNumber?: string;
  password?: string;
}

export function StudentLoginPage() {
  const { loginStudent } = useAuth();
  const navigate = useNavigate();

  const [matricNumber, setMatricNumber] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors: FieldErrors = {};
    if (matricNumber.trim() === "") {
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

  return (
    <AuthShell
      title="Student Login"
      subtitle="Sign in with your matric number to continue."
      footer={
        <>
          <Link to="/register">New student? Register here</Link>
          <Link className="auth-footer__link" to="/staff/login">
            Staff login
          </Link>
        </>
      }
    >
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