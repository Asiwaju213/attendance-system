import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingPage } from "../components/LoadingPage";
import { useAuth } from "../app/useAuth";

interface PlaceholderHomeProps {
  heading: string;
  loginPath: string;
}

function identifierLabel(role: "STUDENT" | "LECTURER" | "ADMIN"): string {
  switch (role) {
    case "STUDENT":
      return "Matric Number";
    case "LECTURER":
      return "Staff ID";
    case "ADMIN":
      return "Username";
  }
}

export function PlaceholderHome({ heading, loginPath }: PlaceholderHomeProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  if (user === null) {
    return <LoadingPage />;
  }

  const identifier = (() => {
    switch (user.role) {
      case "STUDENT":
        return user.matricNumber;
      case "LECTURER":
        return user.staffId;
      case "ADMIN":
        return user.username;
    }
  })();

  async function handleLogout() {
    if (isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    await logout();
    navigate(loginPath, { replace: true });
  }

  return (
    <main className="app-home">
      <section className="app-card" aria-labelledby="app-title">
        <h1 id="app-title">{heading}</h1>
        <p className="app-detail">
          <span className="app-detail__label">Name: </span>
          {user.name}
        </p>
        <p className="app-detail">
          <span className="app-detail__label">Role: </span>
          {user.role}
        </p>
        <p className="app-detail">
          <span className="app-detail__label">{identifierLabel(user.role)}: </span>
          {identifier ?? "Not available"}
        </p>
        <button
          type="button"
          className="auth-submit"
          onClick={handleLogout}
          disabled={isLoggingOut}
          aria-busy={isLoggingOut}
        >
          {isLoggingOut ? "Logging out…" : "Log out"}
        </button>
      </section>
    </main>
  );
}