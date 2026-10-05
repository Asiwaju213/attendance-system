export const ROLES = ["STUDENT", "LECTURER", "ADMIN"] as const;

export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: number;
  name: string;
  username: string | null;
  role: Role;
  /**
   * True while the account still owes the password change that a temporary credential
   * requires. It is never true for an account whose password the owner chose.
   */
  mustChangePassword: boolean;
}

export interface SafeUser {
  id: number;
  name: string;
  role: Role;
  username: string | null;
  matricNumber: string | null;
  staffId: string | null;
  /**
   * Safe boolean only: no hash and no temporary password is ever returned to a client.
   * The frontend uses it to force the password-change screen and nothing else.
   */
  mustChangePassword: boolean;
}
