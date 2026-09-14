export const ROLES = ["STUDENT", "LECTURER", "ADMIN"] as const;

export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: number;
  name: string;
  username: string | null;
  role: Role;
}

export interface SafeUser {
  id: number;
  name: string;
  role: Role;
  username: string | null;
  matricNumber: string | null;
  staffId: string | null;
}