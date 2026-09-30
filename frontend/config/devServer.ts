/**
 * Vite dev-server configuration resolution.
 *
 * The dev server binds to loopback by default, which is what an ordinary local
 * `npm run dev` needs. LAN mode is opt-in: set `VITE_DEV_HOST=0.0.0.0` to let a
 * device on the same local network load the app.
 *
 * The browser never talks to the API directly. `src/api/client.ts` always requests
 * the relative path `/api/...`, and this dev server proxies it to
 * `VITE_API_PROXY_TARGET`. Requests therefore stay same-origin from the browser's
 * point of view, which is what keeps the HTTP-only session cookies working and
 * means the API needs no CORS policy at all — including when the page was loaded
 * from the server PC's LAN address, where `localhost` would mean the phone.
 *
 * The address a device should open is a property of the machine's network
 * configuration. Read it from the machine; never hard-code it here.
 *
 * Binding a listening socket says nothing about how traffic reaches this machine.
 * This module does not — and must not — configure Windows routing, Internet
 * Connection Sharing, NAT, port forwarding or firewall rules.
 */

import { isIP } from 'node:net'

const DEFAULT_DEV_HOST = "127.0.0.1";
const DEFAULT_DEV_PORT = 4173;
const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:5000";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// A single DNS label: alphanumeric, hyphens allowed inside but not at the edges.
const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

// Only digits and dots. A real DNS name cannot have an all-numeric top-level
// label, so a name matching this was meant to be an IPv4 literal and is held to
// the IPv4 rules instead of being accepted as a hostname.
const NUMERIC_DOTTED = /^[0-9.]+$/;

export const DEFAULT_DEV_SERVER_HOST = DEFAULT_DEV_HOST;
export const DEFAULT_DEV_SERVER_PORT = DEFAULT_DEV_PORT;
export const DEFAULT_API_PROXY_TARGET_URL = DEFAULT_API_PROXY_TARGET;

export interface DevServerEnvironment {
  VITE_DEV_HOST?: string | undefined;
  VITE_DEV_PORT?: string | undefined;
  VITE_API_PROXY_TARGET?: string | undefined;
}

export interface DevServerConfig {
  host: string;
  port: number;
  strictPort: true;
  apiProxyTarget: string;
  /** Whether a device on the local network can load the dev server. */
  allowsLanAccess: boolean;
}

function configuredValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isHostname(value: string): boolean {
  if (value.length > 253) {
    return false
  }
  return value
    .split('.')
    .every((label) => label.length > 0 && label.length <= 63 && HOSTNAME_LABEL.test(label))
}

/**
 * A valid IPv4 literal, a valid IPv6 literal, or a DNS hostname — and nothing
 * else. `VITE_DEV_HOST` carries an interface only; the port has its own variable,
 * so a pasted `http://`, path or `host:port` is rejected here with a clear message
 * rather than being handed to Vite. Bracketed IPv6 is accepted and normalised,
 * because that is the form operators tend to copy.
 */
function resolveHost(value: string | undefined): string {
  const host = configuredValue(value) ?? DEFAULT_DEV_HOST

  if (host.startsWith('[') && host.endsWith(']')) {
    const literal = host.slice(1, -1)
    if (isIP(literal) === 6) {
      return literal
    }
  }

  if (isIP(host) !== 0 || (isHostname(host) && !NUMERIC_DOTTED.test(host))) {
    return host
  }

  throw new Error(
    `Invalid value for VITE_DEV_HOST: "${value}". Use an IPv4 address, an IPv6 ` +
      'address or a hostname with no scheme, port or path, for example 127.0.0.1 or 0.0.0.0.',
  )
}

function resolvePort(value: string | undefined): number {
  const port = configuredValue(value);
  if (port === undefined) {
    return DEFAULT_DEV_PORT;
  }
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid value for VITE_DEV_PORT: "${value}". Use a whole number from 1 to 65535.`
    );
  }
  return parsed;
}

/**
 * The API address is reached from the server machine, never from the browser, so
 * `localhost` here is correct in every mode. It must be a plain origin: the proxy
 * owns the whole origin, and a stray path or query would be silently dropped.
 */
function resolveApiProxyTarget(value: string | undefined): string {
  const raw = configuredValue(value) ?? DEFAULT_API_PROXY_TARGET;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid value for VITE_API_PROXY_TARGET: "${value}". Use a full origin, ` +
        "for example http://127.0.0.1:5000."
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid value for VITE_API_PROXY_TARGET: "${value}". Only http and https are supported.`
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `Invalid value for VITE_API_PROXY_TARGET: "${value}". Use a bare origin with no path, ` +
        "for example http://127.0.0.1:5000."
    );
  }
  return url.origin;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function resolveDevServerConfig(
  env: DevServerEnvironment = {}
): DevServerConfig {
  const host = resolveHost(env.VITE_DEV_HOST);
  return {
    host,
    port: resolvePort(env.VITE_DEV_PORT),
    strictPort: true,
    apiProxyTarget: resolveApiProxyTarget(env.VITE_API_PROXY_TARGET),
    allowsLanAccess: !isLoopbackHost(host),
  };
}
