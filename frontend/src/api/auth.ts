import { ApiError, apiRequest } from "./client";
import type { User } from "../types/auth";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "../types/webauthn";

interface AuthResponse {
  user: User;
}

interface MessageResponse {
  message: string;
}

export interface RegistrationIdentityPreview {
  matricNumber: string;
  name: string;
  department: {
    id: number;
    name: string;
    code: string;
  };
  level: {
    id: number;
    name: number;
  };
  challengeToken: string;
}

export interface VerifyRegistrationResponse {
  data: RegistrationIdentityPreview;
}

export interface CompleteRegistrationResponse {
  user: User;
}

/**
 * Options for device-identified student login.
 *
 * `bindingToken` is returned alongside the ceremony options and must be echoed back on
 * verification. Neither value is ever persisted to browser storage.
 */
export interface StudentDeviceLoginOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
  bindingToken: string;
}

export interface StudentDeviceLoginOptionsResponse {
  data: StudentDeviceLoginOptions;
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function studentLogin(matricNumber: string, password: string): Promise<User> {
  return apiRequest<AuthResponse>("/auth/student/login", {
    method: "POST",
    body: { matricNumber, password },
  }).then((data) => data.user);
}

export function lecturerLogin(staffId: string, password: string): Promise<User> {
  return apiRequest<AuthResponse>("/auth/lecturer/login", {
    method: "POST",
    body: { staffId, password },
  }).then((data) => data.user);
}

export function adminLogin(username: string, password: string): Promise<User> {
  return apiRequest<AuthResponse>("/auth/admin/login", {
    method: "POST",
    body: { username, password },
  }).then((data) => data.user);
}

/**
 * Request usernameless WebAuthn options for student login.
 *
 * The response deliberately contains no student identity: the RP has not identified anyone
 * yet. The returned options carry no `allowCredentials`, so the browser offers whichever
 * discoverable passkey the student enrolled and no matric number is ever sent.
 */
export async function startStudentDeviceLogin(): Promise<StudentDeviceLoginOptions> {
  const data = await apiRequest<StudentDeviceLoginOptionsResponse>(
    "/auth/student/device/options",
    { method: "POST" }
  );
  return data.data;
}

/**
 * Complete device-identified student login with the signed assertion and the password.
 */
export function completeStudentDeviceLogin(
  bindingToken: string,
  assertion: AuthenticationResponseJSON,
  password: string
): Promise<User> {
  return apiRequest<AuthResponse>("/auth/student/device/verify", {
    method: "POST",
    body: { bindingToken, assertion, password },
  }).then((data) => data.user);
}

export async function verifyRegistration(matricNumber: string): Promise<RegistrationIdentityPreview> {
  const data = await apiRequest<VerifyRegistrationResponse>("/auth/student/register/verify", {
    method: "POST",
    body: { matricNumber },
  });
  return data.data;
}

export async function completeRegistration(
  challengeToken: string,
  password: string
): Promise<User> {
  const data = await apiRequest<CompleteRegistrationResponse>("/auth/student/register/complete", {
    method: "POST",
    body: { challengeToken, password },
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await apiRequest<MessageResponse>("/auth/logout", { method: "POST" });
}

export interface DeviceBindingResponse {
  hasDeviceBinding: boolean;
  matricNumber?: string;
}

export async function getStudentDeviceBinding(): Promise<DeviceBindingResponse> {
  return apiRequest<DeviceBindingResponse>("/auth/student/device-binding");
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    const data = await apiRequest<AuthResponse>("/auth/me");
    return data.user;
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return null;
    }
    throw error;
  }
}