import { useId } from "react";
import type { InputHTMLAttributes } from "react";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string | undefined;
}

export function Field({ label, error, ...inputProps }: FieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const describedBy = error !== undefined ? errorId : undefined;

  return (
    <div className="field">
      <label htmlFor={inputId} className="field__label">
        {label}
      </label>
      <input
        id={inputId}
        className="field__input"
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {error !== undefined ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}