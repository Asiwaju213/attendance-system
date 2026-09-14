export type Role = "STUDENT" | "LECTURER" | "ADMIN";

export interface User {
  id: number;
  name: string;
  role: Role;
  username: string | null;
  matricNumber: string | null;
  staffId: string | null;
}

export type AuthStatus = "loading" | "unauthenticated" | "authenticated";