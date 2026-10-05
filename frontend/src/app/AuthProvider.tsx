import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as authApi from "../api/auth";
import { AuthContext } from "./auth-context";
import type { AuthContextValue } from "./auth-context";
import type { AuthStatus, User } from "../types/auth";
import type { AuthenticationResponseJSON } from "../types/webauthn";

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

  /**
   * Sign in with a matric number and password.
   *
   * Only the `authenticated` outcome establishes a session here. The backend deliberately refuses
   * to mint one from a matric number and password alone, so the other two outcomes (a
   * first-device enrollment grant, or a refusal because another device is already enrolled) must
   * leave the auth state untouched — calling `applySession` for those would tell the app the
   * student is signed in when no `oou_session` exists.
   */
  const loginStudent = useCallback(
    async (matricNumber: string, password: string) => {
      const result = await authApi.studentLogin(matricNumber, password);
      if (result.outcome === "authenticated") {
        applySession(result.user);
      }
      return result;
    },
    [applySession]
  );

  /**
   * Re-read the current user from the server.
   *
   * Needed after a first-device enrollment: the backend promotes the enrollment grant into a
   * normal session as part of the ceremony, so the session exists but this client never saw the
   * login response that created it.
   */
  const refreshCurrentUser = useCallback(async (): Promise<User | null> => {
    try {
      const currentUser = await authApi.getCurrentUser();
      setUser(currentUser);
      setStatus(currentUser === null ? "unauthenticated" : "authenticated");
      return currentUser;
    } catch {
      setUser(null);
      setStatus("unauthenticated");
      return null;
    }
  }, []);

  /**
   * Device-identified student login. The assertion is the only identity input; the account is
   * resolved and verified entirely server-side, and the session cookie is set by the backend.
   * This reuses the same `applySession` path as the other logins so there is exactly one auth
   * state machine in the app.
   */
  const loginStudentWithDevice = useCallback(
    async (
      bindingToken: string,
      assertion: AuthenticationResponseJSON,
      password: string
    ) => {
      const nextUser = await authApi.completeStudentDeviceLogin(
        bindingToken,
        assertion,
        password
      );
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

  const registerStudent = useCallback(
    async (challengeToken: string, password: string) => {
      const nextUser = await authApi.completeRegistration(challengeToken, password);
      applySession(nextUser);
      return nextUser;
    },
    [applySession]
  );

  const changePassword = useCallback(
    async (
      currentPassword: string,
      newPassword: string,
      confirmPassword: string
    ) => {
      await authApi.changeLecturerPassword({ currentPassword, newPassword, confirmPassword });
      // The backend clears the forced-change flag and revokes the other sessions; re-reading
      // /auth/me is what lets the app leave the change screen on its own.
      return refreshCurrentUser();
    },
    [refreshCurrentUser]
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
      loginStudentWithDevice,
      loginLecturer,
      loginAdmin,
      registerStudent,
      changePassword,
      refreshCurrentUser,
      logout,
    }),
    [
      user,
      status,
      loginStudent,
      loginStudentWithDevice,
      loginLecturer,
      loginAdmin,
      registerStudent,
      changePassword,
      refreshCurrentUser,
      logout
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}