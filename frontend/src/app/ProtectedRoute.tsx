import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { homePathForRole, loginPathForRole } from "./navigation";
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

  return children;
}