import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as authApi from "../api/auth";
import { AuthContext } from "./auth-context";
import type { AuthContextValue } from "./auth-context";
import type { AuthStatus, User } from "../types/auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    authApi
      .getCurrentUser()
      .then((currentUser) => {
        if (cancelled) {
          return;
        }
        setUser(currentUser);
        setStatus(currentUser === null ? "unauthenticated" : "authenticated");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setUser(null);
        setStatus("unauthenticated");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const applySession = useCallback((nextUser: User) => {
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const loginStudent = useCallback(
    async (matricNumber: string, password: string) => {
      const nextUser = await authApi.studentLogin(matricNumber, password);
      applySession(nextUser);
      return nextUser;
    },
    [applySession]
  );

  const loginLecturer = useCallback(
    async (staffId: string, password: string) => {
      const nextUser = await authApi.lecturerLogin(staffId, password);
      applySession(nextUser);
      return nextUser;
    },
    [applySession]
  );

  const loginAdmin = useCallback(
    async (username: string, password: string) => {
      const nextUser = await authApi.adminLogin(username, password);
      applySession(nextUser);
      return nextUser;
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isAuthenticated: status === "authenticated",
      loginStudent,
      loginLecturer,
      loginAdmin,
      logout,
    }),
    [user, status, loginStudent, loginLecturer, loginAdmin, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}