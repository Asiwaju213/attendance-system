import { argon2id, hash, verify, type HashOptions } from "argon2";

const HASH_OPTIONS: HashOptions = { type: argon2id as HashOptions["type"] };

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}