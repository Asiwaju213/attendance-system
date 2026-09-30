import type { ReactNode } from "react";

interface AuthShellProps {
  title: string;
  subtitle?: string | undefined;
  eyebrow: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode | undefined;
}

export function AuthShell({
  title,
  subtitle,
  eyebrow,
  description,
  children,
  footer,
}: AuthShellProps) {
  return (
    <main className="auth-shell">
      <div className="auth-workspace">
        <header className="auth-header">
          <div className="auth-header__brand">
            <span className="auth-header__crest" aria-hidden="true">
              OOU
            </span>
            <span className="auth-header__institution">
              Olabisi Onabanjo University
            </span>
          </div>
          <p className="auth-header__eyebrow">{eyebrow}</p>
          <p className="auth-header__display">Attendance System</p>
          <p className="auth-header__description">{description}</p>
        </header>

        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-panel__inner">
            <h1 id="auth-title" className="auth-panel__title">
              {title}
            </h1>
            {subtitle !== undefined ? (
              <p className="auth-panel__lead">{subtitle}</p>
            ) : null}
            <div className="auth-panel__body">{children}</div>
            {footer !== undefined ? (
              <div className="auth-footer">{footer}</div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
