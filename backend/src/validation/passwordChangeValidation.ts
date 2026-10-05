import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../lib/passwords";

const CHANGE_FIELDS = ["currentPassword", "newPassword", "confirmPassword"] as const;

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

// Passwords are never trimmed: leading or trailing spaces are part of the secret.
function parsePassword(value: unknown, minLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < minLength || value.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return value;
}

/**
 * Strict forced password-change body: exactly the current password, the new password, and the
 * new password typed again. The two new values must match here, so the server never stores a
 * password the user did not confirm.
 */
export function parseChangePasswordBody(body: unknown): ChangePasswordInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const keys = Object.keys(obj).sort();
  const expected = [...CHANGE_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }

  const currentPassword = parsePassword(obj.currentPassword, 1);
  const newPassword = parsePassword(obj.newPassword, MIN_PASSWORD_LENGTH);
  const confirmPassword = parsePassword(obj.confirmPassword, MIN_PASSWORD_LENGTH);
  if (!currentPassword || !newPassword || !confirmPassword) {
    return null;
  }
  if (newPassword !== confirmPassword) {
    return null;
  }

  return { currentPassword, newPassword, confirmPassword };
}
