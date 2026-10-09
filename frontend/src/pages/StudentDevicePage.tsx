import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { homePathForRole } from "../app/navigation";
import { useAuth } from "../app/useAuth";
import { FormError } from "../components/FormError";
import { LoadingPage } from "../components/LoadingPage";
import {
  getDeviceRegistration,
  isWebAuthnSupported,
  WebAuthnUnsupportedError,
} from "../lib/webauthnRegistration";
import { ApiError } from "../api/client";
import {
  completeDeviceEnrollment,
  getStudentDeviceStatus,
  requestDeviceEnrollmentOptions,
  type StudentDeviceState,
  type StudentDeviceStatus,
} from "../api/studentDevice";

/**
 * Why the ceremony finished without leaving the student in the state they expected.
 *
 * Tracked separately from the server state so a successful ceremony that produced a
 * non-discoverable credential can be explained, rather than silently rendered as a healthy
 * "Device Active" card.
 */
type CeremonyNotice = "NOT_DISCOVERABLE" | "ALREADY_ENROLLED" | null;

/**
 * Turn a failure into something a student can act on, without leaking credential ids, challenge
 * values or backend messages.
 *
 * `ApiError` is what the API client throws, so this must branch on it. (This used to test
 * `error instanceof Response`, a branch nothing can ever reach, which collapsed every server
 * error into one generic message.)
 */
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
  if (
    error instanceof DOMException &&
    error.name === "InvalidStateError"
  ) {
    return (
      "This device already has a passkey for this account. " +
      "Try signing in with this device instead, " +
      "or remove the existing passkey from your device's passkey settings and try registering again."
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 409) {
      if (error.code === "CREDENTIAL_IN_USE") {
        return "That authenticator is already registered to another student account. Use a different device or security key.";
      }
      return "Your device status changed while you were registering. The current status is shown below.";
    }
    if (error.status === 400) {
      if (error.code === "INVALID_CHALLENGE") {
        return "That enrollment session expired. Please start again.";
      }
      return "This device could not be registered. Please try again.";
    }
    if (error.status === 404) {
      return "Your student account could not be found. Please contact the registry office.";
    }
    // 401/403 are session problems: the app-level auth handling deals with them, so no message
    // is shown here.
    if (error.status === 401 || error.status === 403) {
      return "Your session has expired. Please sign in again to manage your device.";
    }
  }
  return "Something went wrong. Please try again later.";
}

function formatEnrolledAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function StudentDevicePage() {
  return <StudentDevicePageBody enrollmentOnly={false} />;
}

/**
 * The first-device enrollment page.
 *
 * Rendered outside `ProtectedRoute`, because at this point the student is deliberately *not*
 * signed in: the backend issued a short-lived, single-use enrollment grant instead of a session,
 * and only promotes that grant into a real session once the ceremony commits. Requiring a session
 * here would bounce the student straight back to the login page and make first-device enrollment
 * impossible.
 *
 * The grant is an HttpOnly cookie, so this page cannot read it and does not try to. It simply
 * calls the enrollment endpoints; the backend decides whether the request is authorized.
 */
export function StudentEnrollDevicePage() {
  return <StudentDevicePageBody enrollmentOnly />;
}

function StudentDevicePageBody({ enrollmentOnly }: { enrollmentOnly: boolean }) {
  const { user, logout, refreshCurrentUser } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState<StudentDeviceStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [notice, setNotice] = useState<CeremonyNotice>(null);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  /**
   * Read the device state. Called on mount and again after every ceremony, so the page always
   * reflects what the server actually holds rather than a locally assumed outcome.
   */
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getStudentDeviceStatus());
      setAccessError(null);
    } catch (error) {
      if (
        enrollmentOnly &&
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        // The grant is gone: it expired, it was already spent, or an administrator reset the
        // account. None of those are recoverable from this page, and the failure modes are
        // deliberately indistinguishable, so the student is simply asked to start again.
        setStatus(null);
        setAccessError(
          "Your device enrollment session is no longer valid. Please sign in again to start a new enrollment."
        );
        return;
      }
      // Leave `status` as-is: the error surfaces through the normal auth/transport handling,
      // and keeping the last known state is better than claiming the student has no device.
    } finally {
      setIsLoadingStatus(false);
    }
  }, [enrollmentOnly]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /**
   * Run the existing WebAuthn registration ceremony.
   *
   * The backend decides whether this is an ENROLL or an UPGRADE from the stored device, so this
   * function does not choose a flow; it only performs the ceremony and reports the outcome. When
   * the backend reports `enrollmentMode` we trust it over our local guess, which is what keeps
   * the page honest if the two ever disagree.
   */
  async function handleEnroll() {
    if (isEnrolling) return;

    setEnrollmentError(null);
    setNotice(null);

    if (!isWebAuthnSupported()) {
      setEnrollmentError(deviceErrorMessage(new WebAuthnUnsupportedError()));
      return;
    }

    setIsEnrolling(true);
    try {
      const optionsResponse = await requestDeviceEnrollmentOptions();
      const expectedState: StudentDeviceState =
        optionsResponse.enrollmentMode ?? status?.enrollmentMode ?? "ENROLL";

      const credential = await getDeviceRegistration(optionsResponse.data);
      const result = await completeDeviceEnrollment(credential, deviceLabel.trim() || null);

      // A first-device enrollment arrives holding an enrollment grant rather than a session, so
      // the backend mints the `oou_session` as part of this response. Pick it up before doing
      // anything else: navigating to the dashboard without it would bounce straight back to the
      // login page.
      if (result.sessionCreated === true) {
        const promotedUser = await refreshCurrentUser();
        navigate(
          promotedUser === null ? "/login" : homePathForRole(promotedUser.role),
          { replace: true }
        );
        return;
      }

      // Re-read rather than trusting the completion payload: the device rows are the only source
      // of truth, and this also picks up any concurrent admin reset.
      await refreshStatus();

      if (result.discoverable === false) {
        setNotice("NOT_DISCOVERABLE");
      } else if (expectedState === "UPGRADE") {
        setNotice(null);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The state moved under us (already enrolled, or an admin reset mid-ceremony). The page
        // must not report a failure it cannot interpret: re-read and render the real state.
        setNotice("ALREADY_ENROLLED");
        await refreshStatus();
        setEnrollmentError(deviceErrorMessage(error));
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setEnrollmentError(deviceErrorMessage(error));
      } else {
        setEnrollmentError(deviceErrorMessage(error));
      }
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

  // Without a session and outside the enrollment-only route there is nothing to show: the
  // `ProtectedRoute` guard normally prevents this. In enrollment-only mode `user` is null *by
  // design*, because the student is holding an enrollment grant rather than a session.
  if (user === null && !enrollmentOnly) {
    return <LoadingPage />;
  }

  const state: StudentDeviceState | null = status?.enrollmentMode ?? null;
  const device = status?.device ?? null;

  // State A - no ACTIVE device at all.
  const showEnroll = state === "ENROLL";
  // State B - an ACTIVE device that is not known to be discoverable (false or null).
  const showUpgrade = state === "UPGRADE";
  // State C - a fully enrolled, discoverable device.
  const showActive = state === "ACTIVE";
  // A successful ceremony whose credential turned out not to be discoverable. The device works
  // for attendance, so this is still an upgrade prompt, never a silent "Device Active".
  const showRetryUpgrade = notice === "NOT_DISCOVERABLE" && (showUpgrade || showEnroll);

  return (
    <main className="app-page device-enrollment-page">
      <header className="app-header device-enrollment-header">
        <div className="device-enrollment-header__copy">
          <p className="device-enrollment-header__eyebrow">Student security</p>
          <h1>Device enrollment</h1>
          <p className="app-header__sub">
            {enrollmentOnly
              ? "Register this device to finish signing in. A passkey must be registered on this phone before you can use the system."
              : "Register a passkey so you can mark attendance securely on this device."}
          </p>
        </div>
        <nav className="app-header__nav" aria-label="Student navigation">
          {enrollmentOnly ? (
            // No session yet, so there is no Home to go to and nothing to log out of. The grant is
            // an HttpOnly cookie; leaving this page simply abandons it.
            <Link to="/login">Back to sign in</Link>
          ) : (
            <>
              <Link to={homePathForRole("STUDENT")}>Home</Link>
              <button
                type="button"
                className="secondary-button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                aria-busy={isLoggingOut}
              >
                {isLoggingOut ? "Signing out…" : "Sign out"}
              </button>
            </>
          )}
        </nav>
      </header>

      {accessError !== null ? (
        <div className="resource-error device-enrollment-error" role="alert">
          <FormError message={accessError} />
        </div>
      ) : null}

      <section className="device-status-section" aria-labelledby="device-status-heading">
        <h2 id="device-status-heading" className="device-status-section__title">
          Your Device
        </h2>

        {isLoadingStatus ? (
          <div className="device-status-section__loading" role="status" aria-live="polite">
            <div className="device-enrollment-pending__spinner" aria-hidden="true" />
            <p className="device-enrollment-pending__message">Checking your device…</p>
          </div>
        ) : null}

        {!isLoadingStatus && state === null && accessError === null ? (
          <div className="device-status-card device-status-card--unenrolled">
            <div className="device-status-card__status">
              <span className="device-status-badge device-status-badge--none">
                Status unavailable
              </span>
            </div>
            <p className="device-status-card__description">
              The device status could not be loaded. Reload the page to try again.
            </p>
          </div>
        ) : null}

        {showEnroll || showRetryUpgrade ? (
          <div className="device-status-card device-status-card--unenrolled">
            <div className="device-status-card__status">
              <span className="device-status-badge device-status-badge--none">
                No active device
              </span>
            </div>
            <p className="device-status-card__description">
              {showRetryUpgrade
                ? "The passkey was created but cannot be used to sign in on this device. It still works for marking attendance."
                : "No device is registered on this account yet. Register one to mark attendance."}
            </p>
          </div>
        ) : null}

        {showUpgrade ? (
          <div className="device-status-card device-status-card--warning">
            <div className="device-status-card__status">
              <span className="device-status-badge device-status-badge--warning">
                Upgrade Required
              </span>
            </div>
            {device ? (
              <div className="device-status-card__details">
                <dl className="device-details">
                  <div>
                    <dt>Enrolled</dt>
                    <dd>{formatEnrolledAt(device.enrolledAt)}</dd>
                  </div>
                  {device.label ? (
                    <div>
                      <dt>Label</dt>
                      <dd>{device.label}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
            <p className="device-status-card__description">
              This device is still valid for attendance. Upgrade it before using
              it to sign in, because it was registered before that sign-in method
              became available.
            </p>
            <p className="device-status-card__note">
              Upgrading creates a new passkey on this device. Your existing
              credential is replaced only after the new one is registered
              successfully, so attendance is never interrupted.
            </p>
          </div>
        ) : null}

        {showActive ? (
          <div className="device-status-card device-status-card--enrolled">
            <div className="device-status-card__status">
              <span className="device-status-badge device-status-badge--active">
                Device Active
              </span>
            </div>
            {device ? (
              <div className="device-status-card__details">
                <dl className="device-details">
                  <div>
                    <dt>Enrolled</dt>
                    <dd>{formatEnrolledAt(device.enrolledAt)}</dd>
                  </div>
                  {device.label ? (
                    <div>
                      <dt>Label</dt>
                      <dd>{device.label}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
            <p className="device-status-card__note">
              This device is registered. No further action is needed unless you
              need to sign in on this device, which is not available yet.
            </p>
          </div>
        ) : null}

        {!isLoadingStatus && state !== null ? (
          <>
            {enrollmentError !== null && (
              <div className="resource-error device-enrollment-error">
                <FormError message={enrollmentError} />
              </div>
            )}

            {showEnroll || showUpgrade || showRetryUpgrade ? (
              <div className="device-enrollment-form">
                <div className="field">
                  <label htmlFor="device-label" className="field__label">
                    Device label (optional)
                  </label>
                  <input
                    id="device-label"
                    className="field__input"
                    type="text"
                    maxLength={100}
                    placeholder="e.g. Personal iPhone, work laptop"
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(e.target.value)}
                    disabled={isEnrolling}
                  />
                </div>

                <button
                  type="button"
                  className="auth-submit device-enroll-button"
                  onClick={handleEnroll}
                  disabled={isEnrolling}
                  aria-busy={isEnrolling}
                >
                  {isEnrolling
                    ? "Registering…"
                    : showRetryUpgrade
                      ? "Try device upgrade again"
                      : showUpgrade
                        ? "Upgrade this device"
                        : "Register this device"}
                </button>
              </div>
            ) : null}

            {showEnroll || showUpgrade || showRetryUpgrade ? (
              <p className="device-enrollment-guidance device-enrollment-guidance--note">
                Your browser will ask you to verify with Windows Hello, Touch ID,
                Face ID, or a security key. Verification happens on this device.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {isEnrolling && (
        <section className="device-enrollment-pending" aria-live="polite" aria-busy="true">
          <div className="device-enrollment-pending__spinner" aria-hidden="true" />
          <p className="device-enrollment-pending__message">
            Verifying your device… complete the verification on your device.
          </p>
        </section>
      )}
    </main>
  );
}
