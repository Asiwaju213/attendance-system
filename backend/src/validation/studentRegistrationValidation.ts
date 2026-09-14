import { MAX_MATRIC_LENGTH, normalizeMatric } from "../lib/identity";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_CHALLENGE_TOKEN_LENGTH = 200;

export interface VerifyRegistrationInput {
  matricNumber: string;
}

export interface CompleteRegistrationInput {
  challengeToken: string;
  password: string;
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function parseChallengeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_CHALLENGE_TOKEN_LENGTH) {
    return null;
  }
  return trimmed;
}

function parsePassword(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  return value;
}

export function parseVerifyRegistration(body: unknown): VerifyRegistrationInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  if (typeof obj.matricNumber !== "string") {
    return null;
  }
  const matricNumber = normalizeMatric(obj.matricNumber);
  if (matricNumber.length < 1 || matricNumber.length > MAX_MATRIC_LENGTH) {
    return null;
  }
  return { matricNumber };
}

export function parseCompleteRegistration(body: unknown): CompleteRegistrationInput | null {
  const obj = asObject(body);
  if (!obj) {
    return null;
  }
  const challengeToken = parseChallengeToken(obj.challengeToken);
  const password = parsePassword(obj.password);
  if (!challengeToken || !password) {
    return null;
  }
  return { challengeToken, password };
}