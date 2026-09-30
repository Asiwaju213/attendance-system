import { pool } from "../db/pool";
import { AdminLecturer } from "../types/adminLecturer";
import { OrganizationStatus } from "../types/organization";

interface LecturerRow {
  id: string;
  user_id: string;
  staff_id: string;
  name: string;
  department_id: string;
  department_name: string;
  department_code: string;
  status: OrganizationStatus;
}

export async function listActiveLecturers(): Promise<AdminLecturer[]> {
  const result = await pool.query(
    `SELECT l.id, l.user_id, l.staff_id, l.department_id,
            u.name, u.status,
            d.name AS department_name, d.code AS department_code
     FROM lecturers l
     JOIN users u ON u.id = l.user_id
     JOIN departments d ON d.id = l.department_id
     WHERE u.role = 'LECTURER' AND u.status = 'ACTIVE'
     ORDER BY u.name ASC, l.staff_id ASC`
  );
  return result.rows.map((row: LecturerRow) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    staffId: row.staff_id,
    name: row.name,
    departmentId: Number(row.department_id),
    departmentName: row.department_name,
    departmentCode: row.department_code,
    status: row.status,
  }));
}