import { createContext } from "react";
import type { StudentLoginResult } from "../api/auth";
import type { AuthStatus, User } from "../types/auth";
import type { AuthenticationResponseJSON } from "../types/webauthn";

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  /**
   * Sign in with a matric number and password.
   *
   * Returns the backend's decision rather than assuming success: an authenticated session, a
   * first-device enrollment grant, or a refusal because a device is already enrolled on another
   * device. Only the first establishes a session here.
   */
  loginStudent: (
    matricNumber: string,
    password: string
  ) => Promise<StudentLoginResult>;
  /**
   * Re-read the current user from the server.
   *
   * Needed after an enrollment that promoted an enrollment grant into a session: the session is
   * created by the backend as a side effect of the ceremony, so the client must pick it up.
   */
  refreshCurrentUser: () => Promise<User | null>;
  /**
   * Sign in with a usernameless WebAuthn assertion plus the account password.
   *
   * The ceremony material is passed straight through to the API and is never stored: it is
   * held only by the caller for the duration of the current login attempt.
   */
  loginStudentWithDevice: (
    bindingToken: string,
    assertion: AuthenticationResponseJSON,
    password: string
  ) => Promise<User>;
  loginLecturer: (staffId: string, password: string) => Promise<User>;
  loginAdmin: (username: string, password: string) => Promise<User>;
  registerStudent: (challengeToken: string, password: string) => Promise<User>;
  /**
   * Replace the temporary password a lecturer account was created with.
   *
   * Re-reads the current user from the server afterwards, so the returned user already carries
   * the cleared `mustChangePassword` flag and the app can continue into the lecturer dashboard
   * without a second round trip.
   */
  changePassword: (
    currentPassword: string,
    newPassword: string,
    confirmPassword: string
  ) => Promise<User | null>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
