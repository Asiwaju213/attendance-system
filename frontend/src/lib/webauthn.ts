import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
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
    typeof navigator.credentials?.get === "function"
  );
}

/**
 * Run the browser half of a student device assertion: translate the
 * server-issued JSON options into the WebAuthn DOM types, prompt the
 * authenticator, and serialize the result back to the JSON shape the
 * backend verifies. No challenge/assertion material is persisted anywhere.
 */
export async function getDeviceAssertion(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!isWebAuthnSupported()) {
    throw new WebAuthnUnsupportedError();
  }

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToBytes(options.challenge),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.rpId !== undefined ? { rpId: options.rpId } : {}),
    ...(options.userVerification !== undefined
      ? { userVerification: options.userVerification }
      : {}),
    ...(options.allowCredentials !== undefined
      ? {
          allowCredentials: options.allowCredentials.map((credential) => ({
            id: base64UrlToBytes(credential.id),
            type: "public-key" as const,
            ...(credential.transports !== undefined
              ? { transports: credential.transports as AuthenticatorTransport[] }
              : {}),
          })),
        }
      : {}),
  };

  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;

  if (credential === null) {
    throw new Error("No device credential was returned.");
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  const userHandle = response.userHandle;

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      signature: bytesToBase64Url(response.signature),
      ...(userHandle !== null && userHandle !== undefined
        ? { userHandle: bytesToBase64Url(userHandle) }
        : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults() as Record<
      string,
      unknown
    >,
  };
}
