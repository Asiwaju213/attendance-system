import { createHash, randomBytes } from "crypto";

const TOKEN_BYTES = 32;
const TOKEN_ENCODING: BufferEncoding = "base64url";

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString(TOKEN_ENCODING);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}