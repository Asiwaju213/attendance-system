import { apiRequest } from "./client";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "../types/webauthn";

export interface DeviceEnrollmentOptions {
  data: PublicKeyCredentialCreationOptionsJSON;
}

export interface DeviceEnrollmentCompleteResult {
  credentialId: string;
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

export function completeDeviceEnrollment(
  credential: RegistrationResponseJSON,
  label: string | null
): Promise<DeviceEnrollmentCompleteResult> {
  return apiRequest("/student/device/enrollment/complete", {
    method: "POST",
    body: { credential, label },
  });
}