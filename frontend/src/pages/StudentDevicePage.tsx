import { useState } from "react";
import { Link } from "react-router-dom";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import {
  getDeviceRegistration,
  isWebAuthnSupported,
  WebAuthnUnsupportedError,
} from "../lib/webauthnRegistration";
import {
  requestDeviceEnrollmentOptions,
  completeDeviceEnrollment,
} from "../api/studentDevice";

function deviceErrorMessage(error: unknown): string {
  if (error instanceof WebAuthnUnsupportedError) {
    return "Device enrollment is not supported in this browser. Please use a browser that supports WebAuthn.";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  ) {
    return "Device enrollment was cancelled. Please try again when you are ready.";
  }
  if (error instanceof Response) {
    return "An unexpected error occurred. Please try again later.";
  }
  return "Something went wrong. Please try again later.";
}

export function StudentDevicePage() {
  const { user, logout } = useAuth();

  const [enrolled, setEnrolled] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<{
    enrolledAt: string;
    label: string | null;
  } | null>(null);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState("");

  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleEnroll() {
    if (isEnrolling) return;

    setEnrollmentError(null);
    setIsEnrolling(true);

    try {
      if (!isWebAuthnSupported()) {
        throw new WebAuthnUnsupportedError();
      }

      const optionsResponse = await requestDeviceEnrollmentOptions();
      const credential = await getDeviceRegistration(optionsResponse.data);
      const result = await completeDeviceEnrollment(credential, deviceLabel.trim() || null);

      setDeviceInfo({
        enrolledAt: result.device.enrolledAt,
        label: result.device.label,
      });
      setEnrolled(true);
    } catch (error) {
      setEnrollmentError(deviceErrorMessage(error));
    } finally {
      setIsEnrolling(false);
    }
  }

  async function handleLogout() {
    if (user === null || isLoggingOut) return;
    setIsLoggingOut(true);
    await logout();
    window.location.href = "/login";
  }

  if (user === null) {
    return (
      <main className="loading-page" role="status">
        Loading…
      </main>
    );
  }

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1>Device Enrollment</h1>
          <p className="app-header__sub">
            Register a WebAuthn authenticator (passkey) to enable secure attendance
            marking.
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Student navigation">
          <Link to={homePathForRole("STUDENT")}>Home</Link>
          <button
            type="button"
            className="secondary-button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
          >
            {isLoggingOut ? "Logging out…" : "Log out"}
          </button>
        </nav>
      </header>

      <section className="app-card app-card--wide" aria-labelledby="device-heading">
        <h2 id="device-heading">Your Device</h2>

        {enrolled && deviceInfo ? (
          <div className="device-enrolled">
            <p className="device-status device-status--active">Device Active</p>
            <div className="device-details">
              <p>
                <strong>Enrolled:</strong>{" "}
                {new Date(deviceInfo.enrolledAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
              {deviceInfo.label ? (
                <p>
                  <strong>Label:</strong> {deviceInfo.label}
                </p>
              ) : null}
            </div>
            <p className="note">
              You already have an active device. To register a new device, an
              administrator must reset your current device first.
            </p>
          </div>
        ) : (
          <>
            <p className="device-status device-status--none">No Active Device</p>
            <p className="note">
              You need to register a device before you can mark attendance. Click
              the button below to start the enrollment process using your
              platform authenticator (Windows Hello, Touch ID, Face ID, etc.) or
              a security key.
            </p>
            {enrollmentError !== null && (
              <div className="resource-error">
                <FormError message={enrollmentError} />
              </div>
            )}
            <div className="field">
              <label htmlFor="device-label" className="field__label">
                Device Label (optional)
              </label>
              <input
                id="device-label"
                className="field__input"
                type="text"
                maxLength={100}
                placeholder="e.g., Personal iPhone, Work Laptop"
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                disabled={isEnrolling}
              />
            </div>
            <button
              type="button"
              className="auth-submit"
              onClick={handleEnroll}
              disabled={isEnrolling}
              aria-busy={isEnrolling}
            >
              {isEnrolling ? "Enrolling…" : "Register This Device"}
            </button>
          </>
        )}
      </section>
    </main>
  );
}