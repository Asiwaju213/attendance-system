import { createContext } from "react";
import type { AuthStatus, User } from "../types/auth";
import type { AuthenticationResponseJSON } from "../types/webauthn";

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  loginStudent: (matricNumber: string, password: string) => Promise<User>;
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
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
