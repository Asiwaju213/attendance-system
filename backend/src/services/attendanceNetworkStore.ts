import { pool } from "../db/pool";
import { ActiveNetworkForLecturer, AttendanceNetwork } from "../types/attendanceNetwork";
import { OrganizationStatus } from "../types/organization";
import {
  AttendanceNetworkCreateInput,
  AttendanceNetworkListFilters,
  AttendanceNetworkUpdateInput,
} from "../validation/adminAttendanceNetworkValidation";

export type AttendanceNetworkWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" };

interface AttendanceNetworkRow {
  id: string;
  network_code: string;
  name: string;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

function pgErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code as string | null;
  }
  return null;
}

function toNetwork(row: AttendanceNetworkRow): AttendanceNetwork {
  return {
    id: Number(row.id),
    networkCode: row.network_code,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAttendanceNetworks(
  filters: AttendanceNetworkListFilters
): Promise<AttendanceNetwork[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT id, network_code, name, status, created_at, updated_at
     FROM attendance_networks
     ${whereClause}
     ORDER BY network_code ASC`,
    values
  );
  return result.rows.map(toNetwork);
}

export async function listActiveNetworksForLecturer(): Promise<
  ActiveNetworkForLecturer[]
> {
  const result = await pool.query(
    `SELECT id, network_code, name
     FROM attendance_networks
     WHERE status = 'ACTIVE'
     ORDER BY network_code ASC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    networkCode: row.network_code,
    name: row.name,
  }));
}

export async function findAttendanceNetworkById(
  id: number
): Promise<AttendanceNetwork | null> {
  const result = await pool.query(
    `SELECT id, network_code, name, status, created_at, updated_at
     FROM attendance_networks WHERE id = $1`,
    [id]
  );
  const row = result.rows[0] as AttendanceNetworkRow | undefined;
  return row ? toNetwork(row) : null;
}

export async function createAttendanceNetwork(
  input: AttendanceNetworkCreateInput
): Promise<AttendanceNetworkWriteResult<AttendanceNetwork>> {
  try {
    const result = await pool.query(
      `INSERT INTO attendance_networks (network_code, name)
       VALUES ($1, $2)
       RETURNING id, network_code, name, status, created_at, updated_at`,
      [input.networkCode, input.name]
    );
    return { ok: true, data: toNetwork(result.rows[0] as AttendanceNetworkRow) };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return { ok: false, code: "CONFLICT" };
    }
    throw error;
  }
}

export async function updateAttendanceNetwork(
  id: number,
  input: AttendanceNetworkUpdateInput
): Promise<AttendanceNetworkWriteResult<AttendanceNetwork>> {
  const fields: Array<[string, unknown]> = [];
  if (input.name !== undefined) fields.push(["name", input.name]);
  if (input.status !== undefined) fields.push(["status", input.status]);

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  const result = await pool.query(
    `UPDATE attendance_networks
     SET ${sets.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING id, network_code, name, status, created_at, updated_at`,
    values
  );
  const row = result.rows[0] as AttendanceNetworkRow | undefined;
  if (!row) {
    return { ok: false, code: "NOT_FOUND" };
  }
  return { ok: true, data: toNetwork(row) };
}