import type { ReactNode } from "react";

interface AuthShellProps {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title">{title}</h1>
        {subtitle !== undefined ? <p className="auth-subtitle">{subtitle}</p> : null}
        {children}
        {footer !== undefined ? <div className="auth-footer">{footer}</div> : null}
      </section>
    </main>
  );
}