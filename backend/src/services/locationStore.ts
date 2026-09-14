import { pool } from "../db/pool";
import { ActiveLocationForLecturer, AttendanceLocation } from "../types/location";
import { OrganizationStatus } from "../types/organization";
import {
  LocationCreateInput,
  LocationListFilters,
  LocationUpdateInput,
} from "../validation/adminLocationValidation";

export type LocationWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "NOT_FOUND" };

interface LocationRow {
  id: string;
  name: string;
  description: string | null;
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

function toLocation(row: LocationRow): AttendanceLocation {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLocations(
  filters: LocationListFilters
): Promise<AttendanceLocation[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT id, name, description, status, created_at, updated_at
     FROM locations
     ${whereClause}
     ORDER BY name ASC, id ASC`,
    values
  );
  return result.rows.map(toLocation);
}

export async function listActiveLocationsForLecturer(): Promise<
  ActiveLocationForLecturer[]
> {
  const result = await pool.query(
    `SELECT id, name, description
     FROM locations
     WHERE status = 'ACTIVE'
     ORDER BY name ASC, id ASC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description ?? null,
  }));
}

export async function findLocationById(
  id: number
): Promise<AttendanceLocation | null> {
  const result = await pool.query(
    `SELECT id, name, description, status, created_at, updated_at
     FROM locations WHERE id = $1`,
    [id]
  );
  const row = result.rows[0] as LocationRow | undefined;
  return row ? toLocation(row) : null;
}

export async function createLocation(
  input: LocationCreateInput
): Promise<LocationWriteResult<AttendanceLocation>> {
  const result = await pool.query(
    `INSERT INTO locations (name, description)
     VALUES ($1, $2)
     RETURNING id, name, description, status, created_at, updated_at`,
    [input.name, input.description]
  );
  return { ok: true, data: toLocation(result.rows[0] as LocationRow) };
}

export async function updateLocation(
  id: number,
  input: LocationUpdateInput
): Promise<LocationWriteResult<AttendanceLocation>> {
  const fields: Array<[string, unknown]> = [];
  if (input.name !== undefined) fields.push(["name", input.name]);
  if (input.description !== undefined) fields.push(["description", input.description]);
  if (input.status !== undefined) fields.push(["status", input.status]);

  const sets = fields.map(([column], index) => `${column} = $${index + 1}`);
  const values = fields.map(([, value]) => value);
  values.push(id);

  const result = await pool.query(
    `UPDATE locations
     SET ${sets.join(", ")}
     WHERE id = $${fields.length + 1}
     RETURNING id, name, description, status, created_at, updated_at`,
    values
  );
  const row = result.rows[0] as LocationRow | undefined;
  if (!row) {
    return { ok: false, code: "NOT_FOUND" };
  }
  return { ok: true, data: toLocation(row) };
}