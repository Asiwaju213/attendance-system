import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
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
      // The credential must be discoverable (a resident key / passkey). The student login
      // ceremony resolves the student from the credential alone, and a non-discoverable
      // credential can only be returned by the authenticator when the RP already names it
      // via allowCredentials — which the usernameless login path deliberately does not do.
      // A discoverable credential also works unchanged for the attendance path, so this
      // only widens compatibility.
      residentKey: "required",
      // The server requires user verification on every assertion it verifies, so ask for it
      // here too. Requesting "preferred" would let an authenticator skip verification and
      // then fail verification server-side with no actionable error.
      userVerification: "required",
    },
    // `creds` makes the client report whether the authenticator actually created a
    // discoverable credential. Without it the only available signal is the authenticator's
    // backup-eligibility flags, which is a proxy rather than a statement about resident-key
    // creation. See `detectDiscoverableCredential`.
    extensions: { credProps: true },
    supportedAlgorithmIDs: [-7],
    excludeCredentials: options.excludeCredentials,
    timeout: 60_000,
  });
}

export interface CreateStudentDeviceRequestOptionsParams {
  rpID: string;
  /** The student's enrolled credential, scoped via allowCredentials. */
  credential: { id: string; transports?: string[] | null };
}

/**
 * Build the request options for a student device assertion (the attendance-time
 * authentication path).  The returned `challenge` must be stored server-side (hash only)
 * and the browser signs it with the enrolled private key via `navigator.credentials.get()`.
 */
export async function createStudentDeviceRequestOptions(
  options: CreateStudentDeviceRequestOptionsParams
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: options.rpID,
    allowCredentials: [
      {
        id: options.credential.id,
        ...(options.credential.transports && options.credential.transports.length > 0
          ? { transports: options.credential.transports }
          : {}),
      },
    ],
    userVerification: "preferred",
    timeout: 60_000,
  });
}

export interface CreateStudentDeviceLoginRequestOptionsParams {
  rpID: string;
}

/**
 * Build the request options for the student login ceremony (device-identified login).
 *
 * This is deliberately a *usernameless* assertion: `allowCredentials` is omitted entirely so
 * the authenticator is free to return whichever discoverable passkey the student picks. The
 * browser therefore never needs to send a matric number, and the RP never learns which
 * student is signing in until the assertion has been cryptographically verified.
 *
 * Consequences of omitting `allowCredentials`:
 *   * the credential must be a discoverable (resident) credential — see
 *     `createStudentDeviceRegistrationOptions`, which now enrolls with `residentKey:
 *     "required"`.
 *   * the returned credential ID is the only identity input, which is why it is globally
 *     unique among ACTIVE devices in the database.
 *
 * The returned `challenge` must be stored server-side as a hash only.
 */
export async function createStudentDeviceLoginRequestOptions(
  options: CreateStudentDeviceLoginRequestOptionsParams
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: options.rpID,
    // No allowCredentials: this is the whole point of the login ceremony.
    userVerification: "required",
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
      /**
       * Whether the authenticator created a *discoverable* (resident) credential, i.e. one it
       * can find again on its own. Only a discoverable credential can be used by the
       * usernameless student login ceremony. Persisted at enrollment time because the fact
       * cannot be recovered later — see migration 010.
       */
      discoverable: boolean;
    }
  | { ok: false; reason: string };

/**
 * Decide whether a freshly registered credential is discoverable (a resident key).
 *
 * Two in-band signals are available, in order of directness:
 *
 *  1. `credProps.rk` from the `creds` extension. This is a *client* extension: the browser
 *     inspects the newly created credential and reports whether the authenticator kept it as a
 *     resident key, so it is a direct statement of the thing we care about. It is authoritative
 *     when present, and absent whenever a client ignores the extension.
 *
 *     Note this value lives in the response's `clientExtensionResults`, not in
 *     `registrationInfo.authenticatorExtensionResults`. @simplewebauthn/server populates the
 *     latter from the *attested credential data* extensions, which is a different channel
 *     (authenticator extensions such as `hmacCreateSecret`) and never carries `credProps`.
 *  2. The authenticator's backup-eligibility / backup-state flags (BE 0x08, BS 0x10) in the
 *     attested credential data. These describe backup rather than resident-key creation, so they
 *     are only a proxy — but authenticators that create resident keys set them, which keeps a
 *     false negative (a discoverable credential reported as non-discoverable) unlikely.
 *
 * The function never returns `true` without positive evidence from one of the two, so a
 * credential that cannot be positively identified as discoverable is treated as legacy. That
 * direction is the safe one: the worst case is that a student is offered the authenticated
 * upgrade flow, whereas the opposite error would let a non-discoverable credential be relied on
 * for a ceremony that silently cannot work.
 */
function detectDiscoverableCredential(registration: {
  clientExtensionResults?: unknown;
  attestationObject: Uint8Array<ArrayBuffer>;
}): boolean {
  const clientExtensions = registration.clientExtensionResults as
    | { credProps?: { rk?: unknown } }
    | undefined;
  const reportedRk = clientExtensions?.credProps?.rk;
  if (typeof reportedRk === "boolean") {
    return reportedRk;
  }

  // No `creds` report: fall back to the authenticator data flags.
  try {
    const { attestationObject } = registration;
    const authData = decodeAttestationObject(attestationObject).get("authData");
    const { flags } = parseAuthenticatorData(authData);
    return flags.be || flags.bs;
  } catch {
    // Unparseable attested credential data: the signature verification that runs before this
    // already succeeded, so this should be unreachable, but never claim discoverability on a
    // parse failure.
    return false;
  }
}

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

    const { registrationInfo } = verification;

    return {
      ok: true,
      credential: registrationInfo.credential,
      aaguid: registrationInfo.aaguid,
      credentialDeviceType: registrationInfo.credentialDeviceType,
      credentialBackedUp: registrationInfo.credentialBackedUp,
      discoverable: detectDiscoverableCredential({
        clientExtensionResults: params.response.clientExtensionResults,
        attestationObject: registrationInfo.attestationObject,
      }),
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
  /**
   * Reject assertions whose authenticator did not perform user verification (PIN,
   * fingerprint, face). Defaults to true, which is what `@simplewebauthn/server` also
   * enforces; callers may pass it explicitly so the requirement is visible at the call site.
   */
  requireUserVerification?: boolean;
}

export type StudentDeviceVerificationResult =
  | { ok: true; credentialID: string; newCounter: number }
  | { ok: false; reason: string };

/**
 * Verify a student's WebAuthn assertion.
 *
 * Shared by the attendance-marking path and the student device login path. It also returns
 * the new signature counter, which the caller must persist to the device record.
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
      requireUserVerification: params.requireUserVerification ?? true,
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