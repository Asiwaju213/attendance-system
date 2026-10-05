export type LecturerStatus = "ACTIVE" | "INACTIVE";

export interface AdminLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  departmentName: string;
  departmentCode: string;
  status: LecturerStatus;
  /**
   * Whether the account still owes its first-login password change. A flag for the administrator's
   * benefit, not a credential: the account is limited to the password-change screen until it is
   * false.
   */
  mustChangePassword: boolean;
}

export interface CreateLecturerInput {
  staffId: string;
  name: string;
  departmentId: number;
  temporaryPassword: string;
}

/**
 * The create-lecturer HTTP response.
 *
 * `temporaryPassword` is present only here. The API never returns it again, so the one-time display
 * has to happen immediately after the create call succeeds.
 */
export interface CreateLecturerResponse {
  data: AdminLecturer;
  temporaryPassword: string;
}
