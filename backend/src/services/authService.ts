import { authConfig } from "../config/auth";
import { pool } from "../db/pool";
import { verifyPassword } from "../lib/passwords";
import { generateSessionToken, hashSessionToken } from "../lib/sessions";
import { Role, SafeUser } from "../types/auth";
import { createSession } from "./sessionStore";

export interface AuthenticatedResult {
  token: string;
  safeUser: SafeUser;
}

interface LoginCandidate {
  id: number;
  name: string;
  password_hash: string;
  status: string;
  username: string | null;
  identifier: string;
  role: string;
}

// Look up the account for a given role using its login identifier. Each role
// resolves through its own profile table; the role and profile are checked
// together so a login always matches the correct user type.
const CANDIDATE_QUERIES: Record<Role, string> = {
  STUDENT: `
    SELECT u.id, u.name, u.password_hash, u.status, u.username, u.role,
           s.matric_number AS identifier
    FROM users u
    JOIN students s ON s.user_id = u.id
    WHERE u.role = 'STUDENT' AND s.matric_number = $1
    LIMIT 1`,
  LECTURER: `
    SELECT u.id, u.name, u.password_hash, u.status, u.username, u.role,
           l.staff_id AS identifier
    FROM users u
    JOIN lecturers l ON l.user_id = u.id
    WHERE u.role = 'LECTURER' AND l.staff_id = $1
    LIMIT 1`,
  ADMIN: `
    SELECT u.id, u.name, u.password_hash, u.status, u.username, u.role,
           u.username AS identifier
    FROM users u
    WHERE u.role = 'ADMIN' AND u.username = $1
    LIMIT 1`,
};

// A real Argon2id hash used when the identifier does not exist, so that a
// nonexistent account consumes the same verification time as a wrong password
// (prevents account enumeration by timing).
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$ozaKJsQc9MKty+erbgeqxQ$1BoK4KuIJCXOUG3GILjFDNMP+ht/u+MTceRBGvW1tug";

async function findLoginCandidate(
  role: Role,
  identifier: string
): Promise<LoginCandidate | null> {
  const result = await pool.query(CANDIDATE_QUERIES[role], [identifier]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { ...row, id: Number(row.id) };
}

function toSafeUser(candidate: LoginCandidate): SafeUser {
  const role = candidate.role as Role;
  return {
    id: candidate.id,
    name: candidate.name,
    role,
    username: role === "ADMIN" ? candidate.identifier : null,
    matricNumber: role === "STUDENT" ? candidate.identifier : null,
    staffId: role === "LECTURER" ? candidate.identifier : null,
  };
}

export async function authenticate(
  role: Role,
  identifier: string,
  password: string
): Promise<AuthenticatedResult | null> {
  const candidate = await findLoginCandidate(role, identifier);

  if (!candidate) {
    await verifyPassword(DUMMY_PASSWORD_HASH, password);
    return null;
  }

  const passwordMatches = await verifyPassword(candidate.password_hash, password);
  if (!passwordMatches || candidate.status !== "ACTIVE") {
    return null;
  }

  const token = generateSessionToken();
  await createSession(
    candidate.id,
    hashSessionToken(token),
    new Date(Date.now() + authConfig.sessionLifetimeMs)
  );

  return { token, safeUser: toSafeUser(candidate) };
}