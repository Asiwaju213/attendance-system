// WebAuthn / passkey Relying Party (RP) configuration.
//
// Production values must be set via environment variables and are required when
// NODE_ENV=production:
//   WEBAUTHN_RP_ID     - the domain the credential is scoped to (no protocol/port),
//                        e.g. "attendance.oou.edu.ng"
//   WEBAUTHN_ORIGIN    - the exact frontend origin the WebAuthn ceremony runs in,
//                        e.g. "https://attendance.oou.edu.ng" (no trailing slash)
//   WEBAUTHN_RP_NAME   - human-readable RP name, defaults to the project name
//
// For local development the origin already used by the project is supported out of the
// box: the Vite dev server runs on http://localhost:4173 (see README), whose WebAuthn
// RP ID is "localhost".

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";

const DEFAULT_RP_NAME = "OOU Attendance System";
const DEV_RP_ID = "localhost";
const DEV_ORIGIN = "http://localhost:4173";

export const webauthnConfig = {
  rpName: process.env.WEBAUTHN_RP_NAME ?? DEFAULT_RP_NAME,

  rpID: isProduction
    ? requireEnv("WEBAUTHN_RP_ID")
    : (process.env.WEBAUTHN_RP_ID ?? DEV_RP_ID),

  expectedOrigin: isProduction
    ? requireEnv("WEBAUTHN_ORIGIN")
    : (process.env.WEBAUTHN_ORIGIN ?? DEV_ORIGIN),

  // How long a device-enrollment challenge stays usable before it becomes unverifiable.
  challengeTtlMs: 10 * 60 * 1000,

  // WebAuthn is configured for the platform authenticator (Windows Hello, Touch ID,
  // Android biometrics, ...) with discoverable credentials, matching the passkeys
  // best practices. Only ES256 (ECDSA P-256) keys are accepted so verification works
  // on every runtime without depending on optional Web Crypto algorithms.
  supportedAlgorithmIDs: [-7],
};