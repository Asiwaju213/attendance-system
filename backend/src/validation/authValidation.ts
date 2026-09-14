const MAX_IDENTIFIER_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 200;

export interface LoginCredentials {
  identifier: string;
  password: string;
}

function parseStringField(
  body: unknown,
  field: string,
  maxLength: number
): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function parsePassword(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>).password;
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < 1 || value.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return value;
}

export function parseLoginCredentials(
  body: unknown,
  identifierField: string
): LoginCredentials | null {
  const identifier = parseStringField(body, identifierField, MAX_IDENTIFIER_LENGTH);
  const password = parsePassword(body);
  if (!identifier || !password) {
    return null;
  }
  return { identifier, password };
}