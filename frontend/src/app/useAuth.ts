import { useContext } from "react";
import { AuthContext } from "./auth-context";
import type { AuthContextValue } from "./auth-context";

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }
  return context;
}