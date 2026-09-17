import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export const MAX_CREDENTIAL_ID_LENGTH = 1024;
export const MAX_CREDENTIAL_FIELD_LENGTH = 16384;
export const MAX_CHALLENGE_LENGTH = 1024;

export interface MarkAttendanceInput {
  attendanceSessionId: number;
  /** Raw challenge extracted from the assertion's clientDataJSON, used to look up the stored hash. */
  challenge: string;
  assertion: AuthenticationResponseJSON;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseIntegerField(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < min || value > max) {
      return null;
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  }
  return null;
}

function isBase64UrlString(value: unknown, maxLength: number): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > maxLength) {
    return false;
  }
  // Base64url profile only (no padding "+", "/" or "=").
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    Buffer.from(value, "base64url");
    return true;
  } catch {
    return false;
  }
}

function decodeClientData(
  clientDataJSON: string
): { type: string; challenge: string | null; origin: string | null } {
  try {
    const json = Buffer.from(clientDataJSON, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as {
      type?: unknown;
      challenge?: unknown;
      origin?: unknown;
    };
    return {
      type: typeof parsed.type === "string" ? parsed.type : "",
      challenge:
        typeof parsed.challenge === "string" && parsed.challenge.length > 0
          ? parsed.challenge
          : null,
      origin: typeof parsed.origin === "string" ? parsed.origin : null,
    };
  } catch {
    return { type: "", challenge: null, origin: null };
  }
}

/**
 * Validate a WebAuthn authentication response (assertion) exactly as the browser would
 * serialize it from `navigator.credentials.get()`.  Reuses the shape conventions from the
 * device-enrollment validator.  Returns the parsed assertion plus the raw challenge so the
 * service can hash it and match against stored challenge state.
 */
export function parseDeviceAssertion(
  body: unknown
): { assertion: AuthenticationResponseJSON; challenge: string } | null {
  const obj = asObject(body as ((...args: unknown[]) => unknown) & { [k: string]: never });
  if (!obj) {
    return null;
  }

  if (obj.type !== "public-key") {
    return null;
  }
  const id = obj.id;
  if (!isBase64UrlString(id, MAX_CREDENTIAL_ID_LENGTH)) {
    return null;
  }
  if (obj.rawId !== id) {
    return null;
  }

  const response = asObject(obj.response);
  if (!response) {
    return null;
  }
  if (
    !isBase64UrlString(response.clientDataJSON, MAX_CREDENTIAL_FIELD_LENGTH) ||
    !isBase64UrlString(response.authenticatorData, MAX_CREDENTIAL_FIELD_LENGTH) ||
    !isBase64UrlString(response.signature, MAX_CREDENTIAL_FIELD_LENGTH)
  ) {
    return null;
  }
  if (
    response.userHandle !== undefined &&
    !isBase64UrlString(response.userHandle, MAX_CREDENTIAL_ID_LENGTH)
  ) {
    return null;
  }

  const clientData = decodeClientData(response.clientDataJSON as string);
  if (clientData.type !== "webauthn.get" || clientData.origin === null) {
    return null;
  }
  const challenge = clientData.challenge;
  if (challenge === null || challenge.length > MAX_CHALLENGE_LENGTH) {
    return null;
  }

  if (obj.clientExtensionResults !== undefined && obj.clientExtensionResults !== null) {
    if (
      typeof obj.clientExtensionResults !== "object" ||
      Array.isArray(obj.clientExtensionResults)
    ) {
      return null;
    }
  }

  return {
    challenge,
    assertion: obj as unknown as AuthenticationResponseJSON,
  };
}

export function parseMarkAttendance(body: unknown): MarkAttendanceInput | null {
  const obj = asObject(body as ((...args: unknown[]) => unknown) & { [k: string]: never });
  if (!obj) {
    return null;
  }

  const attendanceSessionId = parseIntegerField(
    obj.attendanceSessionId,
    1,
    Number.MAX_SAFE_INTEGER
  );
  if (attendanceSessionId === null) {
    return null;
  }

  const assertionResult = parseDeviceAssertion(obj.assertion);
  if (!assertionResult) {
    return null;
  }

  return {
    attendanceSessionId,
    challenge: assertionResult.challenge,
    assertion: assertionResult.assertion,
  };
}