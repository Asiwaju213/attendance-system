import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { LoadingPage } from "../components/LoadingPage";
import { changePasswordPath, homePathForRole, loginPathForRole } from "./navigation";
import { useAuth } from "./useAuth";
import type { Role } from "../types/auth";

interface ProtectedRouteProps {
  role: Role;
  children: ReactNode;
}

export function ProtectedRoute({ role, children }: ProtectedRouteProps) {
  const { status, user } = useAuth();

  if (status === "loading") {
    return <LoadingPage />;
  }

  if (status === "unauthenticated" || user === null) {
    return <Navigate to={loginPathForRole(role)} replace />;
  }

  if (user.role !== role) {
    return <Navigate to={homePathForRole(user.role)} replace />;
  }

  if (user.mustChangePassword) {
    // A forced password change is not just a prompt: the backend refuses every route behind
    // this guard until it is done, so navigating straight to a dashboard URL would only load a
    // page whose data requests all fail.
    return <Navigate to={changePasswordPath} replace />;
  }

  return <AppShell>{children}</AppShell>;
}
