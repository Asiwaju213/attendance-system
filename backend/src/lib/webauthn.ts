import {
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

/**
 * Shared WebAuthn building blocks for the OOU Attendance System.
 *
 * Everything an RP must do around the WebAuthn ceremony lives here so future flows
 * (notably student device authentication during an attendance session) reuse the same
 * verification logic instead of duplicating it.
 */

export interface StudentDeviceCredentialRecord {
  /** base64url-encoded credential ID, as stored in `student_devices.credential_id`. */
  id: string;
  /** Raw COSE public-key bytes, as stored in `student_devices.credential_public_key`. */
  publicKey: Uint8Array<ArrayBuffer>;
  /** Last known authenticator signature counter. */
  counter: number;
  transports?: string[];
}

export interface CreateRegistrationOptionsParams {
  rpName: string;
  rpID: string;
  userName: string;
  userDisplayName: string;
  userID: Uint8Array<ArrayBuffer>;
  excludeCredentials: { id: string; transports?: string[] }[];
}

export async function createStudentDeviceRegistrationOptions(
  options: CreateRegistrationOptionsParams
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: options.rpName,
    rpID: options.rpID,
    userName: options.userName,
    userDisplayName: options.userDisplayName,
    userID: options.userID,
    attestationType: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7],
    excludeCredentials: options.excludeCredentials,
    timeout: 60_000,
  });
}

export interface VerifyStudentRegistrationParams {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
}

export type StudentRegistrationVerificationResult =
  | {
      ok: true;
      credential: WebAuthnCredential;
      aaguid: string;
      credentialDeviceType: "singleDevice" | "multiDevice";
      credentialBackedUp: boolean;
    }
  | { ok: false; reason: string };

export async function verifyStudentRegistration(
  params: VerifyStudentRegistrationParams
): Promise<StudentRegistrationVerificationResult> {
  try {
    const verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: params.expectedOrigin,
      expectedRPID: params.expectedRPID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, reason: "The registration was not verified." };
    }

    return {
      ok: true,
      credential: verification.registrationInfo.credential,
      aaguid: verification.registrationInfo.aaguid,
      credentialDeviceType: verification.registrationInfo.credentialDeviceType,
      credentialBackedUp: verification.registrationInfo.credentialBackedUp,
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export interface VerifyStudentDeviceParams {
  /**
   * The stored credential for the device being used to authenticate, so assertion
   * verification is bound to exactly the credential the student enrolled.
   */
  credential: StudentDeviceCredentialRecord;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
}

export type StudentDeviceVerificationResult =
  | { ok: true; credentialID: string; newCounter: number }
  | { ok: false; reason: string };

/**
 * Verify a student's WebAuthn assertion (the future attendance-authentication path).
 *
 * Attendance sessions are NOT implemented yet; this helper exists so that flow can call
 * `verifyStudentDevice(...)` without re-implementing WebAuthn verification. It also
 * returns the new signature counter, which the caller must persist to the device record.
 */
export async function verifyStudentDevice(
  params: VerifyStudentDeviceParams
): Promise<StudentDeviceVerificationResult> {
  try {
    const verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: params.expectedOrigin,
      expectedRPID: params.expectedRPID,
      credential: {
        id: params.credential.id,
        publicKey: params.credential.publicKey,
        counter: params.credential.counter,
        transports: params.credential.transports,
      },
    });

    if (!verification.verified) {
      return { ok: false, reason: "The authentication was not verified." };
    }

    return {
      ok: true,
      credentialID: verification.authenticationInfo.credentialID,
      newCounter: verification.authenticationInfo.newCounter,
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}