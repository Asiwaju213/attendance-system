import { apiRequest } from "./client";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "../types/webauthn";

/**
 * `ENROLL`  - the student had no active device.
 * `UPGRADE` - the student had an active device that is not known to be discoverable (enrolled
 *             before the `residentKey: "required"` policy). The new discoverable credential
 *             replaces it on completion, and the old one keeps working until then.
 */
export type DeviceEnrollmentMode = "ENROLL" | "UPGRADE";

/**
 * The student's current device state, as reported by the read-only status endpoint.
 *
 * `ACTIVE` is a status-only value: it means the ACTIVE device is a discoverable credential, so
 * no enrollment or upgrade is needed. It is deliberately not part of `DeviceEnrollmentMode`,
 * because there is no ceremony that starts from it.
 */
export type StudentDeviceState = DeviceEnrollmentMode | "ACTIVE";

export interface StudentDeviceSummary {
  enrolledAt: string;
  label: string | null;
}

export interface StudentDeviceStatus {
  /**
   * `ENROLL`  - no ACTIVE device. The student has not registered a device yet.
   * `UPGRADE` - an ACTIVE device that is not known to be discoverable. It still works for
   *             attendance and can be replaced by re-running the enrollment ceremony.
   * `ACTIVE`  - an ACTIVE device that is a discoverable credential.
   */
  enrollmentMode: StudentDeviceState;
  /**
   * The stored discoverability of the ACTIVE device, or null when there is no ACTIVE device.
   *
   * `null` is also reported for a device enrolled before discoverability was recorded, meaning
   * "unknown". It is never treated as discoverable, so both `null` and `false` lead to
   * `enrollmentMode: "UPGRADE"`.
   */
  discoverable: boolean | null;
  /** Minimal display details. Contains no credential id or other credential internals. */
  device: StudentDeviceSummary | null;
}

export interface DeviceEnrollmentOptions {
  data: PublicKeyCredentialCreationOptionsJSON;
  /** Optional: an older backend that does not report it will leave this undefined. */
  enrollmentMode?: DeviceEnrollmentMode;
}

export interface DeviceEnrollmentCompleteResult {
  credentialId: string;
  /** Set only when an upgrade replaced a previous credential; always null otherwise. */
  replacedCredentialId?: string | null;
  /**
   * Whether the new credential is known to be discoverable. `false` means the authenticator
   * ignored `residentKey: "required"`, so the credential works for attendance but cannot be
   * used for the usernameless login.
   */
  discoverable?: boolean;
  device: {
    credentialId: string;
    status: "ACTIVE";
    enrolledAt: string;
    label: string | null;
  };
}

export function requestDeviceEnrollmentOptions(): Promise<DeviceEnrollmentOptions> {
  return apiRequest("/student/device/enrollment/options", { method: "POST" });
}

/**
 * Read the student's current device state.
 *
 * This is a plain GET on purpose. It must not be replaced by a call to
 * `requestDeviceEnrollmentOptions`: that endpoint starts a WebAuthn ceremony and expires any
 * challenge the student already has outstanding, so using it as a status check would cancel an
 * in-progress enrollment (and, because the challenge is shared, a pending attendance
 * verification).
 */
export function getStudentDeviceStatus(): Promise<StudentDeviceStatus> {
  return apiRequest("/student/device");
}

export function completeDeviceEnrollment(
  credential: RegistrationResponseJSON,
  label: string | null
): Promise<DeviceEnrollmentCompleteResult> {
  return apiRequest("/student/device/enrollment/complete", {
    method: "POST",
    body: { credential, label },
  });
}