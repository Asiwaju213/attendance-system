import type { RegistrationResponseJSON } from "@simplewebauthn/server";

export const MAX_DEVICE_LABEL_LENGTH = 100;
export const MAX_CREDENTIAL_ID_LENGTH = 1024;
export const MAX_CREDENTIAL_FIELD_LENGTH = 16384;

export interface CompleteDeviceEnrollmentInput {
  credential: RegistrationResponseJSON;
  label: string | null;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
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

function parseLabel(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_DEVICE_LABEL_LENGTH) {
    return "invalid";
  }
  return trimmed;
}

function isTransports(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 100
  );
}

export function parseCompleteDeviceEnrollment(
  body: unknown
): CompleteDeviceEnrollmentInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }

  const label = parseLabel(obj.label);
  if (label === "invalid") {
    return null;
  }

  const raw = obj.credential;
  const credential = asObject(raw);
  if (!credential) {
    return null;
  }

  if (credential.type !== "public-key") {
    return null;
  }
  if (!isBase64UrlString(credential.id, MAX_CREDENTIAL_ID_LENGTH)) {
    return null;
  }
  if (credential.rawId !== credential.id) {
    return null;
  }

  const response = asObject(credential.response);
  if (!response) {
    return null;
  }
  if (
    !isBase64UrlString(response.clientDataJSON, MAX_CREDENTIAL_FIELD_LENGTH) ||
    !isBase64UrlString(response.attestationObject, MAX_CREDENTIAL_FIELD_LENGTH)
  ) {
    return null;
  }

  let clientData: unknown;
  try {
    const json = Buffer.from(response.clientDataJSON as string, "base64url").toString(
      "utf8"
    );
    clientData = JSON.parse(json);
  } catch {
    clientData = null;
  }
  const clientDataObj = asObject(clientData);
  if (!clientDataObj) {
    return null;
  }
  if (clientDataObj.type !== "webauthn.create") {
    return null;
  }
  if (typeof clientDataObj.origin !== "string") {
    return null;
  }

  if (!isTransports(response.transports)) {
    return null;
  }

  if (credential.clientExtensionResults !== undefined) {
    if (
      typeof credential.clientExtensionResults !== "object" ||
      credential.clientExtensionResults === null ||
      Array.isArray(credential.clientExtensionResults)
    ) {
      return null;
    }
  }

  return {
    credential: credential as unknown as RegistrationResponseJSON,
    label: label as string | null,
  };
}