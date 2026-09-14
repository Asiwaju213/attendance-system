import { createHash, randomBytes } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Test-only WebAuthn fixtures.
 *
 * `@simplewebauthn/server` ships no helpers for building valid registration/assertion
 * responses, so these fixtures synthesize real ones the same way an authenticator would:
 * an ECDSA P-256 / ES256 (COSE alg -7) keypair, a packed attestation object, correctly
 * formed clientDataJSON, and correct signatures over
 * `authenticatorData || SHA-256(clientDataJSON)`.
 *
 * Production enrollment/verification is 100% driven by @simplewebauthn/server; this
 * fixture builder is only used so the tests exercise the real verification path.
 */

const AAGUID = Uint8Array.from([0x62, 0x7e, 0x0d, 0x1b, 0xea, 0x6d, 0x4a, 0x90, 0x9b,
  0x9f, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60]);

// UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) | AT (0x40) — a user-verified authenticator
// performing attestation, which satisfy requireUserVerification in verification.
const REGISTRATION_FLAGS = 0x5d;
// UP (0x01) | UV (0x04) — a user-verified authenticator performing an assertion.
const ASSERTION_FLAGS = 0x05;

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function encodeDerInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  let value = bytes.slice(start);
  // DER integers are signed; a leading high bit needs a 0x00 pad byte.
  if ((value[0] & 0x80) === 0x80) {
    const padded = new Uint8Array(value.length + 1);
    padded.set(value, 1);
    value = padded;
  }
  return concat(Uint8Array.of(0x02), encodeDerLength(value.length), value);
}

/**
 * WebCrypto `subtle.sign` returns an ECDSA signature as raw `r || s` (IEEE P1363), but WebAuthn
 * transports it as an ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`. @simplewebauthn/server parses
 * the DER form, so the fixture must re-encode it to exercise the real verification path.
 */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const body = concat(
    encodeDerInteger(raw.slice(0, half)),
    encodeDerInteger(raw.slice(half))
  );
  return concat(Uint8Array.of(0x30), encodeDerLength(body.length), body);
}

function clientDataJSONBytes(
  type: string,
  challenge: string,
  origin: string
): Uint8Array {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    "utf8"
  );
}

/**
 * A simulated authenticator holding an ES256 keypair plus the metadata WebAuthn produces.
 */
export interface TestAuthenticator {
  credentialId: Uint8Array;
  userId: Uint8Array;
  credentialPublicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface RegistrationFixtureOptions {
  challenge: string;
  origin: string;
  rpId: string;
  /** Override the default registration-specific AAGUID/flags. */
  aaguid?: Uint8Array;
  flags?: number;
  signCount?: number;
  /** Override the default clientDataJSON type. */
  clientDataType?: string;
}

export async function createTestAuthenticator(
  credentialIdLen = 32
): Promise<TestAuthenticator> {
  const { crypto } = globalThis;
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const rawPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey)
  );
  // SEC1 uncompressed point: 0x04 || X (32) || Y (32)
  const x = rawPublicKey.slice(1, 33);
  const y = rawPublicKey.slice(33, 65);

  const cosePublicKey = new Map<number, unknown>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);

  return {
    credentialId: randomBytes(credentialIdLen),
    userId: randomBytes(16),
    credentialPublicKey: isoCBOR.encode(cosePublicKey),
    privateKey: keyPair.privateKey,
  };
}

function buildAuthData(
  rpId: string,
  flags: number,
  signCount: number,
  attested?: {
    credentialId: Uint8Array;
    credentialPublicKey: Uint8Array;
    aaguid: Uint8Array;
  }
): Uint8Array {
  const rpIdHash = sha256(Buffer.from(rpId, "utf8"));
  const base = concat(rpIdHash, Uint8Array.of(flags), uint32BE(signCount));
  // Only registration ceremonies carry attested credential data (AT flag).
  if (!attested) {
    return base;
  }
  const credIdLen = uint32BE(attested.credentialId.length).slice(-2);
  return concat(
    base,
    attested.aaguid,
    credIdLen,
    attested.credentialId,
    attested.credentialPublicKey
  );
}

async function sign(
  privateKey: CryptoKey,
  message: Uint8Array
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      message
    )
  );
  return rawSignatureToDer(raw);
}

export interface BuildRegistrationParams {
  authenticator: TestAuthenticator;
  challenge: string;
  origin: string;
  rpId: string;
  /** Include `userHandle` in authenticatorData (optional per WebAuthn). */
  withUserHandle?: boolean;
}

/**
 * Build a registration response (packed attestation) as a browser would serialize it
 * from `navigator.credentials.create()`.
 */
export async function buildRegistrationResponse(
  params: BuildRegistrationParams
): Promise<RegistrationResponseJSON> {
  const { authenticator, challenge, origin, rpId } = params;
  const cdata = clientDataJSONBytes("webauthn.create", challenge, origin);
  const authData = buildAuthData(rpId, REGISTRATION_FLAGS, 1, {
    credentialId: authenticator.credentialId,
    credentialPublicKey: authenticator.credentialPublicKey,
    aaguid: AAGUID,
  });

  const signature = await sign(
    authenticator.privateKey,
    concat(authData, sha256(cdata))
  );

  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "packed"],
      ["attStmt", new Map<string, unknown>([["alg", -7], ["sig", signature]])],
      ["authData", authData],
    ])
  );

  const id = isoBase64URL.fromBuffer(authenticator.credentialId);

  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(cdata),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
      publicKeyAlgorithm: -7,
    },
  };
}

export interface BuildAssertionParams {
  authenticator: TestAuthenticator;
  challenge: string;
  origin: string;
  rpId: string;
  /** Override the authenticatorData sign count. */
  signCount?: number;
}

/**
 * Build an authentication response (assertion) as a browser would serialize it from
 * `navigator.credentials.get()`.
 */
export async function buildAuthenticationResponse(
  params: BuildAssertionParams
): Promise<AuthenticationResponseJSON> {
  const { authenticator, challenge, origin, rpId } = params;
  const cdata = clientDataJSONBytes("webauthn.get", challenge, origin);
  const authData = buildAuthData(
    rpId,
    ASSERTION_FLAGS,
    params.signCount ?? 2
  );

  const signature = await sign(
    authenticator.privateKey,
    concat(authData, sha256(cdata))
  );

  const id = isoBase64URL.fromBuffer(authenticator.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(cdata),
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(signature),
      userHandle: isoBase64URL.fromBuffer(authenticator.userId),
    },
  };
}

export { AAGUID };