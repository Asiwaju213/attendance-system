import { createContext } from "react";
import type { AuthStatus, User } from "../types/auth";

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  loginStudent: (matricNumber: string, password: string) => Promise<User>;
  loginLecturer: (staffId: string, password: string) => Promise<User>;
  loginAdmin: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);