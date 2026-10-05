import { OrganizationStatus } from "./organization";

export interface AdminLecturer {
  id: number;
  userId: number;
  staffId: string;
  name: string;
  departmentId: number;
  departmentName: string;
  departmentCode: string;
  status: OrganizationStatus;
  /**
   * Whether this account still owes its first-login password change.
   *
   * A flag, not a credential: it tells an administrator that the account is still limited to the
   * password-change screen. No password or hash is ever part of this shape.
   */
  mustChangePassword: boolean;
}