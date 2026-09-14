import { useCallback, useEffect, useState } from "react";

/**
 * TEMPORARY — network investigation page (prototype only).
 *
 * Calls the unauthenticated `GET /api/debug/network` endpoint twice:
 *   1. through the Vite dev proxy (relative URL) — what normal app traffic does
 *   2. directly to the Express backend on port 5000 — so the real client address
 *      is visible instead of the proxy's 127.0.0.1
 *
 * Not linked from any app navigation. Remove this page and its route in
 * `app/routes.tsx` once the investigation is finished.
 */

interface NetworkDebugData {
  ip: string | null;
  ips: string[];
  protocol: string;
  secure: boolean;
  hostname: string;
  trustProxy: unknown;
  trustProxyExplanation: string;
  headers: {
    host: string | string[] | null;
    "x-forwarded-for": string | string[] | null;
    "x-real-ip": string | string[] | null;
    forwarded: string | string[] | null;
    "user-agent": string | string[] | null;
  };
  connection: {
    remoteAddress: string | null;
    remotePort: number | null;
    remoteFamily: string | null;
    localAddress: string | null;
    localPort: number | null;
    encrypted: boolean;
  };
}

interface NetworkDebugResponse {
  data: NetworkDebugData;
}

const BACKEND_PORT = 5000;

function directBackendUrl(): string {
  // Same host the page was loaded from (localhost on the laptop, the laptop's
  // LAN IP on the phone), but pointed straight at the Express backend.
  return `http://${window.location.hostname}:${BACKEND_PORT}/api/debug/network`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "— (absent)";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "— (empty)" : value.join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

const RECORD_HINT = "← record this";

function Row({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: unknown;
  highlight?: boolean;
}) {
  return (
    <div className="app-detail">
      <span className="app-detail__label">{label}: </span>
      <span
        style={highlight ? { fontWeight: 700, wordBreak: "break-all" } : undefined}
      >
        {formatValue(value)}
      </span>
      {highlight ? (
        <span style={{ marginLeft: 8, opacity: 0.6, fontSize: "0.85em" }}>
          {RECORD_HINT}
        </span>
      ) : null}
    </div>
  );
}

function ObservationBlock({
  heading,
  note,
  data,
  error,
}: {
  heading: string;
  note: string;
  data: NetworkDebugData | null;
  error: string | null;
}) {
  return (
    <section aria-label={heading}>
      <h2 style={{ marginTop: 24 }}>{heading}</h2>
      <p className="app-detail" style={{ opacity: 0.7 }}>
        {note}
      </p>
      {error !== null ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      ) : null}
      {data !== null ? (
        <>
          <Row label="ip (req.ip)" value={data.ip} highlight />
          <Row label="ips (req.ips)" value={data.ips} highlight />
          <Row label="protocol" value={data.protocol} highlight />
          <Row label="secure" value={data.secure} />
          <Row label="hostname" value={data.hostname} />
          <Row label="trustProxy" value={data.trustProxy} />
          <Row
            label="trustProxy explanation"
            value={data.trustProxyExplanation}
          />
          <Row label="host header" value={data.headers.host} />
          <Row
            label="x-forwarded-for"
            value={data.headers["x-forwarded-for"]}
            highlight
          />
          <Row label="x-real-ip" value={data.headers["x-real-ip"]} />
          <Row label="forwarded" value={data.headers.forwarded} />
          <Row label="user-agent" value={data.headers["user-agent"]} />
          <Row
            label="raw remoteAddress"
            value={data.connection.remoteAddress}
          />
          <Row label="raw remotePort" value={data.connection.remotePort} />
          <Row label="raw localAddress" value={data.connection.localAddress} />
        </>
      ) : null}
    </section>
  );
}

export function NetworkTestPage() {
  const [proxyData, setProxyData] = useState<NetworkDebugData | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [directData, setDirectData] = useState<NetworkDebugData | null>(null);
  const [directError, setDirectError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    const proxyRequest = fetch("/api/debug/network", {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        return (await response.json()) as NetworkDebugResponse;
      })
      .then((body) => {
        setProxyData(body.data);
        setProxyError(null);
      })
      .catch(() => {
        setProxyData(null);
        setProxyError("Could not reach /api/debug/network (proxied).");
      });

    const directRequest = fetch(directBackendUrl(), {
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        return (await response.json()) as NetworkDebugResponse;
      })
      .then((body) => {
        setDirectData(body.data);
        setDirectError(null);
      })
      .catch(() => {
        setDirectData(null);
        setDirectError(
          `Could not reach ${directBackendUrl()} directly. Check the backend is running and bound to 0.0.0.0:${BACKEND_PORT}.`
        );
      });

    await Promise.allSettled([proxyRequest, directRequest]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleRefresh() {
    setIsLoading(true);
    void load();
  }

  return (
    <main className="app-home">
      <section className="app-card" aria-labelledby="network-test-title">
        <h1 id="network-test-title">Network observation (temporary)</h1>
        <p className="app-detail" style={{ opacity: 0.75 }}>
          Investigation only. No login, no attendance impact. Values marked with{" "}
          {RECORD_HINT}. Compare the two blocks: the proxied block is what the
          normal app sees; the direct block reveals the real client address.
        </p>

        <button
          type="button"
          className="auth-submit"
          onClick={handleRefresh}
          disabled={isLoading}
          aria-busy={isLoading}
        >
          {isLoading ? "Loading…" : "Refresh"}
        </button>

        <ObservationBlock
          heading="1. Through the Vite dev proxy (relative /api)"
          note="This is how the real frontend calls the backend. Expect the proxy (127.0.0.1) here."
          data={proxyData}
          error={proxyError}
        />

        <ObservationBlock
          heading={`2. Direct to Express (${directBackendUrl()})`}
          note="Bypasses the proxy so Express sees the actual client. Use this to compare router vs mobile data."
          data={directData}
          error={directError}
        />
      </section>
    </main>
  );
}
