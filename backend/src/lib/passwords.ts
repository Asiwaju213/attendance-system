import { argon2id, hash, verify, type HashOptions } from "argon2";

// Password bounds for every credential this system issues or accepts. They match the
// policy the student self-registration flow already enforces.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

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

// A real Argon2id hash used when the account cannot be resolved, so that an unknown
// identifier or a credential with no stored hash consumes the same verification time as a
// wrong password (prevents account enumeration by timing).
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$ozaKJsQc9MKty+erbgeqxQ$1BoK4KuIJCXOUG3GILjFDNMP+ht/u+MTceRBGvW1tug";

/**
 * Verify a password, always paying the cost of one Argon2id verification.
 *
 * A null `passwordHash` means the account has no password set (e.g. a PENDING student
 * awaiting registration), so there is nothing to compare against. The dummy hash keeps the
 * response time indistinguishable from a wrong password.
 */
export async function verifyPasswordOrDummy(
  passwordHash: string | null,
  password: string
): Promise<boolean> {
  if (passwordHash === null) {
    await verifyPassword(DUMMY_PASSWORD_HASH, password);
    return false;
  }
  return verifyPassword(passwordHash, password);
}