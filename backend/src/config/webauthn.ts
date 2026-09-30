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

  // How long an attendance device-verification challenge stays usable.  Shorter than
  // enrollment because attendance happens in-class on a known device.
  attendanceChallengeTtlMs: 5 * 60 * 1000,

  // How long a student device-login challenge stays usable.  This is the shortest window in
  // the system: the challenge is issued before the student is identified, is unauthenticated,
  // and only needs to survive one passkey prompt.  It is persisted with an explicit
  // `expires_at`, so the database enforces the bound even if this value is changed later.
  loginChallengeTtlMs: 2 * 60 * 1000,

  // Abuse brakes for the public student device login endpoints.  Challenge issuance is
  // capped separately from verification so a caller cannot spin up unbounded outstanding
  // challenges, and repeated failed verifications are capped to slow password guessing.
  // Both are per-process and reset when the API restarts.
  loginChallengeRateLimit: {
    maxChallenges: 20,
    windowMs: 5 * 60 * 1000,
  },
  loginFailureRateLimit: {
    maxFailures: 10,
    windowMs: 5 * 60 * 1000,
  },

  // WebAuthn is configured for the platform authenticator (Windows Hello, Touch ID,
  // Android biometrics, ...) with discoverable credentials, matching the passkeys
  // best practices. Only ES256 (ECDSA P-256) keys are accepted so verification works
  // on every runtime without depending on optional Web Crypto algorithms.
  supportedAlgorithmIDs: [-7],
};