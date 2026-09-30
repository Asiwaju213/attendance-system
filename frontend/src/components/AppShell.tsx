import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  appNavigationForRole,
  homePathForRole,
  loginPathForRole,
} from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { LoadingPage } from "./LoadingPage";

interface AppNavProps {
  items: ReadonlyArray<{ label: string; href: string }>;
  isActive: (href: string) => boolean;
}

function AppNav({ items, isActive }: AppNavProps) {
  return (
    <nav className="app-sidebar__nav" aria-label="Primary">
      <ul className="app-sidebar__navlist">
        {items.map((item) => (
          <li key={item.href} className="app-sidebar__item">
            <Link
              to={item.href}
              className="app-sidebar__link"
              aria-current={isActive(item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface AppAccountProps {
  role: string;
  signingOut: boolean;
  onSignOut: () => void;
}

function AppAccount({ role, signingOut, onSignOut }: AppAccountProps) {
  return (
    <div className="app-sidebar__account">
      <span className="app-sidebar__role">Signed in as {role}</span>
      <button
        type="button"
        className="app-signout"
        onClick={onSignOut}
        disabled={signingOut}
        aria-busy={signingOut}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const previousPathname = useRef(location.pathname);

  useEffect(() => {
    if (location.pathname !== previousPathname.current) {
      previousPathname.current = location.pathname;
      setMenuOpen(false);
    }
  }, [location.pathname]);

  useEffect(() => {
    document.body.classList.toggle("app-shell-lock", menuOpen);
    return () => {
      document.body.classList.remove("app-shell-lock");
    };
  }, [menuOpen]);

  if (user === null) {
    return <LoadingPage />;
  }

  const role = user.role;
  const navigation = appNavigationForRole(role);
  const home = homePathForRole(role);

  function isActive(href: string): boolean {
    const pathname = location.pathname;
    if (pathname === href) {
      return true;
    }
    if (href === home) {
      return false;
    }
    return pathname.startsWith(`${href}/`);
  }

  const activeItem =
    navigation.items.find((item) => isActive(item.href)) ?? navigation.items[0];
  const sectionLabel = activeItem?.label ?? "Overview";

  async function handleSignOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    await logout();
    navigate(loginPathForRole(role), { replace: true });
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-shell">
        <aside className="app-sidebar">
          <Link to={home} className="app-sidebar__brand">
            <span className="app-sidebar__crest">OOU</span>
            <span className="app-sidebar__brandtext">
              <span className="app-sidebar__name">
                Olabisi Onabanjo University
              </span>
              <span className="app-sidebar__system">Attendance System</span>
            </span>
          </Link>
          <AppNav items={navigation.items} isActive={isActive} />
          <AppAccount
            role={navigation.roleLabel}
            signingOut={signingOut}
            onSignOut={handleSignOut}
          />
        </aside>

        <div className="app-shell__maincol">
          <header className="app-topbar">
            <Link to={home} className="app-topbar__brand">
              <span className="app-sidebar__crest">OOU</span>
              <span>Attendance</span>
            </Link>
            <button
              type="button"
              className="app-topbar__toggle"
              aria-expanded={menuOpen}
              aria-controls="app-mobilenav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? "Close" : "Menu"}
            </button>
          </header>

          {menuOpen ? (
            <div className="app-mobilenav" id="app-mobilenav">
              <AppNav items={navigation.items} isActive={isActive} />
              <AppAccount
                role={navigation.roleLabel}
                signingOut={signingOut}
                onSignOut={handleSignOut}
              />
            </div>
          ) : null}

          <div className="app-shell__content" id="main-content" tabIndex={-1}>
            <p className="app-shell__eyebrow">
              <span className="app-shell__eyebrow-product">OOU Attendance</span>
              <span aria-hidden="true"> · </span>
              <span>{sectionLabel}</span>
            </p>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}