import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "../types/webauthn";

export class WebAuthnUnsupportedError extends Error {
  constructor() {
    super("WebAuthn is not available in this browser.");
    this.name = "WebAuthnUnsupportedError";
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

/**
 * Run the browser half of a student device registration: translate the
 * server-issued JSON options into the WebAuthn DOM types, prompt the
 * authenticator, and serialize the result back to the JSON shape the
 * backend verifies. No challenge/credential material is persisted anywhere.
 */
export async function getDeviceRegistration(
  options: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  if (!isWebAuthnSupported()) {
    throw new WebAuthnUnsupportedError();
  }

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64UrlToBytes(options.challenge),
    rp: options.rp,
    user: {
      ...options.user,
      id: base64UrlToBytes(options.user.id),
    },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.authenticatorSelection !== undefined
      ? { authenticatorSelection: options.authenticatorSelection }
      : {}),
    ...(options.excludeCredentials !== undefined
      ? {
          excludeCredentials: options.excludeCredentials.map((credential) => ({
            id: base64UrlToBytes(credential.id),
            type: "public-key" as const,
            ...(credential.transports !== undefined
              ? { transports: credential.transports as AuthenticatorTransport[] }
              : {}),
          })),
        }
      : {}),
    ...(options.attestation !== undefined
      ? { attestation: options.attestation }
      : {}),
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;

  if (credential === null) {
    throw new Error("No device credential was returned.");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = response.getTransports() as AuthenticatorTransport[];

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
      ...(transports.length > 0 ? { transports } : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults() as Record<
      string,
      unknown
    >,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}