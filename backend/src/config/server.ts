import { isIP } from "net";

/**
 * HTTP server binding configuration.
 *
 * The API binds to the loopback interface by default, so an ordinary `npm run dev`
 * is only reachable from the machine running it. That is the safe default for both
 * local work and a cloud deployment.
 *
 * LAN mode is opt-in: set `HOST=0.0.0.0` to listen on every interface, or set `HOST`
 * to one specific LAN address to listen only there. The address a device should use
 * is a property of the machine's network configuration, so it must always come from
 * the environment; it is never written into source.
 *
 * Binding a listening socket says nothing about how traffic reaches this machine.
 * This module does not — and must not — configure Windows routing, Internet
 * Connection Sharing, NAT, port forwarding or firewall rules.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ANY_HOSTS = new Set(["0.0.0.0", "::"]);

// A single DNS label: alphanumeric, hyphens allowed inside but not at the edges.
const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

// Only digits and dots. A real DNS name cannot have an all-numeric top-level
// label, so a name matching this was meant to be an IPv4 literal and is held to
// the IPv4 rules instead of being accepted as a hostname.
const NUMERIC_DOTTED = /^[0-9.]+$/;

export const DEFAULT_SERVER_HOST = DEFAULT_HOST;
export const DEFAULT_SERVER_PORT = DEFAULT_PORT;

export interface ServerConfig {
  host: string;
  port: number;
}

/** Treats an unset or whitespace-only value as "not configured". */
function configuredValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isHostname(value: string): boolean {
  if (value.length > 253) {
    return false;
  }
  return value
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && HOSTNAME_LABEL.test(label));
}

/**
 * A valid IPv4 literal, a valid IPv6 literal, or a DNS hostname — and nothing
 * else. `HOST` carries an interface only; the port has its own variable, so a
 * pasted `http://`, path or `host:port` is rejected here with a clear message
 * rather than reaching `listen()` and failing obscurely. Bracketed IPv6 is
 * accepted and normalised, because that is the form operators tend to copy.
 */
function resolveHost(value: string | undefined): string {
  const host = configuredValue(value) ?? DEFAULT_HOST;

  if (host.startsWith("[") && host.endsWith("]")) {
    const literal = host.slice(1, -1);
    if (isIP(literal) === 6) {
      return literal;
    }
  }

  if (isIP(host) !== 0 || (isHostname(host) && !NUMERIC_DOTTED.test(host))) {
    return host;
  }

  throw new Error(
    `Invalid value for HOST: "${value}". Use an IPv4 address, an IPv6 address or a ` +
      "hostname with no scheme, port or path, for example 127.0.0.1, 0.0.0.0 or " +
      "attendance.example.edu."
  );
}

function resolvePort(value: string | undefined): number {
  const port = configuredValue(value);
  if (port === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid value for PORT: "${value}". Use a whole number from 1 to 65535.`);
  }
  return parsed;
}

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: resolveHost(env.HOST),
    port: resolvePort(env.PORT),
  };
}

/**
 * The effective binding for this process. Read after `dotenv.config()` has run —
 * `index.ts` relies on importing `./app` first to guarantee that.
 */
export const serverConfig: ServerConfig = resolveServerConfig(process.env);

/**
 * True when the process is reachable only from the machine it runs on. Used to
 * report the listening scope at startup and to describe LAN mode in the log.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** True for the wildcard binds (`0.0.0.0`, `::`) that expose every interface. */
export function isAnyHost(host: string): boolean {
  return ANY_HOSTS.has(host.toLowerCase());
}

/**
 * Whether this binding can be reached from another device on the local network.
 * True for the wildcard binds and for any specific non-loopback address.
 */
export function isNetworkAccessibleHost(host: string): boolean {
  return !isLoopbackHost(host);
}

/** Startup log line. Contains only the bind address, never configuration secrets. */
export function describeServerConfig(config: ServerConfig): string {
  const { host, port } = config;
  if (isLoopbackHost(host)) {
    return `OOU Attendance System API listening on http://${host}:${port} (loopback only).`;
  }
  if (isAnyHost(host)) {
    return `OOU Attendance System API listening on http://${host}:${port} (all interfaces - reachable from the local network).`;
  }
  return `OOU Attendance System API listening on http://${host}:${port} (single network interface - reachable from the local network).`;
}
