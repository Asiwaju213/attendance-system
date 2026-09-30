import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

/**
 * Public shapes for the student device login ceremony.
 *
 * The response deliberately carries no student identity: it is issued before the student is
 * known. The binding token is the only secret the client holds, and it is stored server-side
 * as a hash only.
 */

export interface StudentDeviceLoginOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
  bindingToken: string;
}
