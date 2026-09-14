import { ApiError, apiRequest } from "./client";
import type { User } from "../types/auth";

interface AuthResponse {
  user: User;
}

interface MessageResponse {
  message: string;
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

export async function logout(): Promise<void> {
  await apiRequest<MessageResponse>("/auth/logout", { method: "POST" });
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