interface LoadingPageProps {
  label?: string;
}

export function LoadingPage({ label = "Loading…" }: LoadingPageProps) {
  return (
    <main className="loading-page" role="status">
      {label}
    </main>
  );
}