import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { parseDeviceAssertion } from "./studentAttendanceValidation";

/**
 * Request validation for the student device login ceremony.
 *
 * The body carries no identifier of any kind — no matric number, no student id, no user id.
 * The only identity input is the WebAuthn assertion, and even that is treated as untrusted
 * input until the server has resolved the credential and verified its signature.
 */

const MAX_BINDING_TOKEN_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 200;

export interface StudentDeviceLoginInput {
  /**
   * Opaque token issued alongside the challenge options and never persisted in the clear. It
   * binds the challenge to the single browser flow that requested it.
   */
  bindingToken: string;
  /** The challenge lifted out of the assertion's clientDataJSON, to be hashed and matched. */
  challenge: string;
  assertion: AuthenticationResponseJSON;
  password: string;
}

function isBase64UrlString(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > maxLength) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function parseStudentDeviceLoginBody(body: unknown): StudentDeviceLoginInput | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const obj = body as Record<string, unknown>;

  const bindingToken = obj.bindingToken;
  if (!isBase64UrlString(bindingToken, MAX_BINDING_TOKEN_LENGTH)) {
    return null;
  }

  const password = obj.password;
  if (typeof password !== "string") {
    return null;
  }
  if (password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }

  // Reuses the attendance assertion validator, so the ceremony is parsed and bounded exactly
  // the same way whether it is proving attendance or proving identity at login.
  const assertion = parseDeviceAssertion(obj.assertion);
  if (assertion === null) {
    return null;
  }

  return {
    bindingToken,
    challenge: assertion.challenge,
    assertion: assertion.assertion,
    password,
  };
}
