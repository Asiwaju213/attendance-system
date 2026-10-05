export type Role = "STUDENT" | "LECTURER" | "ADMIN";

export interface User {
  id: number;
  name: string;
  role: Role;
  username: string | null;
  matricNumber: string | null;
  staffId: string | null;
  /**
   * True while a temporary password issued by an administrator still has to be replaced.
   * The backend blocks every API surface except the password change itself while it is set,
   * and the app keeps the lecturer on the change screen.
   */
  mustChangePassword: boolean;
}

export type AuthStatus = "loading" | "unauthenticated" | "authenticated";
