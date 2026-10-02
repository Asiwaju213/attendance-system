import type { PoolClient } from "pg";
import { SYNC_PAYLOAD_VERSION } from "../config/sync";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncedAcademicSession,
  SyncedAttendanceNetwork,
  SyncedCourse,
  SyncedCourseOffering,
  SyncedDepartment,
  SyncedEntityPayload,
  SyncedFaculty,
  SyncedLecturer,
  SyncedLevel,
  SyncedLocation,
  SyncedSemester,
} from "../types/sync";
import { SyncApplyError } from "./syncErrors";

/**
 * Applies synchronized master data to the edge database.
 *
 * Two different destinations, and the difference is the whole point of Task 2's
 * scope decision:
 *
 * - The nine reference tables (faculties, departments, levels, courses,
 *   academic_sessions, semesters, course_offerings, locations,
 *   attendance_networks) are mirrored into the edge's REAL tables. The edge never
 *   authors these rows, so writing the cloud's authoritative copy in place of an
 *   absent local one keeps foreign keys, joins and existing queries working
 *   normally instead of behind a parallel projection.
 *
 * - Lecturers go to the `sync_lecturers` projection instead. A lecturer's
 *   `user_id` points into `users`, and the edge's `users` table is its own
 *   authentication store for local admins and locally-enrolled students.
 *   Writing cloud identity into that table would put cloud-owned identity records
 *   into the edge's login store. The display name is denormalized into the
 *   projection so nothing needs a row in `users` to attribute a session.
 *
 * Nothing here copies a password hash, a username, an email, or a WebAuthn or
 * device credential id, because no such field exists in any payload type.
 *
 * Every statement is a fixed shape with bound parameters. Table names are never
 * interpolated from event data: they come from the literal union below.
 */

/**
 * Tables this module may write to.
 *
 * A literal union rather than a string, so no table name in a generated statement
 * can be influenced by event data.
 */
type MirroredTable =
  | "faculties"
  | "departments"
  | "levels"
  | "courses"
  | "academic_sessions"
  | "semesters"
  | "course_offerings"
  | "locations"
  | "attendance_networks"
  | "sync_lecturers";

/**
 * A subquery resolving a cloud UUID to the edge's local integer id.
 *
 * Yields NULL when the parent has not been mirrored yet; the NOT NULL foreign key
 * then refuses the write and the apply service turns that into a named error
 * rather than a dangling reference. `$param` is the placeholder number in the
 * statement being built, so a caller's cloud UUIDs are never bound into an
 * integer column.
 */
function parent(table: MirroredTable, param: number): string {
  return `(SELECT id FROM ${table} WHERE sync_id = $${param})`;
}

/** The business key that means "this edge already had this entity". */
interface NaturalKey {
  /** Unique column, or unique column tuple, that identifies the entity. */
  columns: string[];
  /** Bound values, when the key columns are cloud-supplied scalars. */
  values?: unknown[];
  /**
   * SQL expressions yielding the key values instead of bound parameters.
   *
   * Needed for `course_offerings`, whose business key is a tuple of LOCAL integer
   * ids that are themselves resolved from cloud UUIDs. Placeholders in these
   * expressions continue after the update statement's own parameters.
   */
  expressions?: string[];
}

interface MirroredUpsert {
  table: MirroredTable;
  /**
   * The column holding the cloud identity.
   *
   * `sync_id` on every mirrored real table; `cloud_sync_id` on the lecturer
   * projection, which is named that way to make it unambiguous that the value is
   * the cloud's and not a local identity.
   */
  identityColumn: string;
  /** Full INSERT statement. May embed parent-resolution subqueries. */
  insertSql: string;
  /** Bind values for `insertSql`, in placeholder order. */
  insertValues: unknown[];
  /**
   * SET clause for the UPDATE, using `$1..$n`.
   *
   * It must assign the identity column from `$1`, because the same clause serves
   * both to refresh a row that already carries the cloud identity and to adopt the
   * cloud identity onto a pre-existing local row.
   *
   * `updated_at` is deliberately absent from every real-table statement: those
   * tables all carry the `set_updated_at` trigger from migration 001, which
   * already refreshes it on UPDATE. `sync_lecturers` is created by migration 013
   * and has no trigger, so it sets the column explicitly.
   */
  set: string;
  /** Bind values for `set`, in placeholder order. */
  setValues: unknown[];
  naturalKey: NaturalKey | null;
}

/**
 * Write the cloud's version of one master-data entity into the edge.
 *
 * Three attempts, in order, and the first that touches a row is the whole write.
 * Two match paths rather than a single `INSERT ... ON CONFLICT (sync_id)` is the
 * important part, and it exists for a concrete reason:
 *
 *   Migrations 001, 004 and 008 seed the SAME reference rows into both databases:
 *   levels 100-500, the two semesters, the 'Unassigned Faculty' placeholder, the
 *   'Faculty of Engineering' faculty and its five departments. Migration 013 then
 *   gives both sides independent `gen_random_uuid()` defaults, so the edge's copy
 *   of level 100 carries a different UUID from the cloud's copy.
 *
 *   An upsert that only conflicts on `sync_id` would therefore not conflict at
 *   all, and the INSERT would instead violate the UNIQUE constraint on the
 *   business key - `levels.name`, `faculties.code`, `departments.code`,
 *   `semesters.name`, `courses.course_code`, `academic_sessions.name` or
 *   `attendance_networks.network_code`. That aborts the whole apply transaction,
 *   so a fresh edge could never synchronize past its own seed data.
 *
 *   Matching the business key and adopting the cloud's `sync_id` onto the
 *   existing row resolves that collision AND keeps the row's local integer id
 *   stable, which preserves every local foreign key already pointing at it.
 *
 * Every attempt runs inside the caller's transaction, and the apply service holds
 * `FOR UPDATE` on the consumer cursor for the duration of the batch, so these
 * statements cannot interleave with another applier for the same edge.
 */
async function upsertMirrored(
  client: PoolClient,
  spec: MirroredUpsert
): Promise<void> {
  const bySyncId = await client.query(
    `UPDATE ${spec.table} SET ${spec.set} WHERE ${spec.identityColumn} = $1`,
    [...spec.setValues]
  );
  if ((bySyncId.rowCount ?? 0) > 0) {
    return;
  }

  const key = spec.naturalKey;
  if (key) {
    // Placeholder numbering continues after the SET clause's own parameters.
    const offset = spec.setValues.length;
    const params: unknown[] = [...spec.setValues];
    let keyOperand: string;

    if (key.expressions) {
      keyOperand = key.expressions.join(", ");
    } else {
      for (const value of key.values ?? []) {
        params.push(value);
      }
      keyOperand = params
        .slice(offset)
        .map((_, index) => `$${offset + index + 1}`)
        .join(", ");
    }

    // Row comparison, so a single-column key and the course-offering tuple use
    // exactly the same shape.
    const byKey = await client.query(
      `UPDATE ${spec.table}
       SET ${spec.set}
       WHERE (${key.columns.join(", ")}) = (${keyOperand})`,
      params
    );
    if ((byKey.rowCount ?? 0) > 0) {
      return;
    }
  }

  await client.query(spec.insertSql, spec.insertValues);
}

/** Entity types this module knows how to apply. */
export const MASTER_DATA_ENTITY_TYPES: readonly SyncEntityType[] = [
  "faculty",
  "department",
  "level",
  "course",
  "academic_session",
  "semester",
  "course_offering",
  "location",
  "attendance_network",
  "lecturer",
] as const;

export function isMasterDataEntityType(
  entityType: string
): entityType is (typeof MASTER_DATA_ENTITY_TYPES)[number] {
  return (MASTER_DATA_ENTITY_TYPES as readonly string[]).includes(entityType);
}

function requirePayload<T>(
  entityType: SyncEntityType,
  payload: SyncedEntityPayload
): T {
  const value = payload as T;
  if (!value || typeof value !== "object") {
    throw new SyncApplyError(
      `Cloud ${entityType} payload is missing or not an object.`
    );
  }
  return value;
}

/**
 * A parent reference must be a usable UUID string before it reaches SQL.
 *
 * Without this, a payload with a missing or null parent would resolve to NULL in
 * the subquery and surface as a bare foreign-key violation naming no field.
 */
function requireParentRef(
  entityType: SyncEntityType,
  field: string,
  value: unknown
): string {
  if (typeof value !== "string" || value === "") {
    throw new SyncApplyError(
      `Cloud ${entityType} payload is missing its ${field} reference.`
    );
  }
  return value;
}

async function applyFaculty(
  client: PoolClient,
  payload: SyncedFaculty
): Promise<void> {
  const values = [payload.syncId, payload.name, payload.code, payload.status];
  await upsertMirrored(client, {
    table: "faculties",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO faculties (sync_id, name, code, status)
                VALUES ($1, $2, $3, $4)`,
    insertValues: values,
    set: "sync_id = $1, name = $2, code = $3, status = $4",
    setValues: values,
    naturalKey: { columns: ["code"], values: [payload.code] },
  });
}

async function applyDepartment(
  client: PoolClient,
  payload: SyncedDepartment
): Promise<void> {
  const facultyRef = requireParentRef(
    "department",
    "cloudFacultySyncId",
    payload.cloudFacultySyncId
  );
  const values = [
    payload.syncId,
    payload.name,
    payload.code,
    facultyRef,
    payload.status,
  ];
  await upsertMirrored(client, {
    table: "departments",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO departments (sync_id, name, code, faculty_id, status)
                VALUES ($1, $2, $3, ${parent("faculties", 4)}, $5)`,
    insertValues: values,
    set: `sync_id = $1, name = $2, code = $3,
          faculty_id = ${parent("faculties", 4)}, status = $5`,
    setValues: values,
    naturalKey: { columns: ["code"], values: [payload.code] },
  });
}

async function applyLevel(
  client: PoolClient,
  payload: SyncedLevel
): Promise<void> {
  // `levels` has no status and no updated_at: it is a static lookup restricted to
  // 100..500 by a CHECK constraint.
  const values = [payload.syncId, payload.name];
  await upsertMirrored(client, {
    table: "levels",
    identityColumn: "sync_id",
    insertSql: "INSERT INTO levels (sync_id, name) VALUES ($1, $2)",
    insertValues: values,
    set: "sync_id = $1, name = $2",
    setValues: values,
    naturalKey: { columns: ["name"], values: [payload.name] },
  });
}

async function applyCourse(
  client: PoolClient,
  payload: SyncedCourse
): Promise<void> {
  const levelRef = requireParentRef(
    "course",
    "cloudLevelSyncId",
    payload.cloudLevelSyncId
  );
  // A course belongs to exactly one faculty or one department (CHECK
  // `chk_courses_single_owner`), so the two nullable parents are passed through
  // as-is and the constraint is what enforces the rule.
  const values = [
    payload.syncId,
    payload.courseCode,
    payload.title,
    payload.cloudDepartmentSyncId,
    payload.cloudFacultySyncId,
    levelRef,
    payload.status,
  ];
  await upsertMirrored(client, {
    table: "courses",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO courses
                  (sync_id, course_code, title, department_id, faculty_id, level_id, status)
                VALUES ($1, $2, $3, ${parent("departments", 4)},
                        ${parent("faculties", 5)}, ${parent("levels", 6)}, $7)`,
    insertValues: values,
    set: `sync_id = $1, course_code = $2, title = $3,
          department_id = ${parent("departments", 4)},
          faculty_id = ${parent("faculties", 5)},
          level_id = ${parent("levels", 6)},
          status = $7`,
    setValues: values,
    naturalKey: { columns: ["course_code"], values: [payload.courseCode] },
  });
}

async function applyAcademicSession(
  client: PoolClient,
  payload: SyncedAcademicSession
): Promise<void> {
  const values = [payload.syncId, payload.name, payload.isActive];
  await upsertMirrored(client, {
    table: "academic_sessions",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO academic_sessions (sync_id, name, is_active)
                VALUES ($1, $2, $3)`,
    insertValues: values,
    set: "sync_id = $1, name = $2, is_active = $3",
    setValues: values,
    naturalKey: { columns: ["name"], values: [payload.name] },
  });
}

async function applySemester(
  client: PoolClient,
  payload: SyncedSemester
): Promise<void> {
  const values = [payload.syncId, payload.name];
  await upsertMirrored(client, {
    table: "semesters",
    identityColumn: "sync_id",
    insertSql: "INSERT INTO semesters (sync_id, name) VALUES ($1, $2)",
    insertValues: values,
    set: "sync_id = $1, name = $2",
    setValues: values,
    naturalKey: { columns: ["name"], values: [payload.name] },
  });
}

async function applyCourseOffering(
  client: PoolClient,
  payload: SyncedCourseOffering
): Promise<void> {
  const values = [
    payload.syncId,
    requireParentRef(
      "course_offering",
      "cloudCourseSyncId",
      payload.cloudCourseSyncId
    ),
    requireParentRef(
      "course_offering",
      "cloudAcademicSessionSyncId",
      payload.cloudAcademicSessionSyncId
    ),
    requireParentRef(
      "course_offering",
      "cloudSemesterSyncId",
      payload.cloudSemesterSyncId
    ),
    payload.status,
  ];

  await upsertMirrored(client, {
    table: "course_offerings",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO course_offerings
                  (sync_id, course_id, academic_session_id, semester_id, status)
                VALUES ($1, ${parent("courses", 2)}, ${parent("academic_sessions", 3)},
                        ${parent("semesters", 4)}, $5)`,
    insertValues: values,
    set: `sync_id = $1,
          course_id = ${parent("courses", 2)},
          academic_session_id = ${parent("academic_sessions", 3)},
          semester_id = ${parent("semesters", 4)},
          status = $5`,
    setValues: values,
    // The business key is the (course, academic session, semester) triple, and
    // its values are LOCAL ids, so they are resolved from the cloud UUIDs rather
    // than bound directly. Placeholders $6-$8 continue after the five above.
    naturalKey: {
      columns: ["course_id", "academic_session_id", "semester_id"],
      expressions: [
        parent("courses", 6),
        parent("academic_sessions", 7),
        parent("semesters", 8),
      ],
    },
  });
}

async function applyLocation(
  client: PoolClient,
  payload: SyncedLocation
): Promise<void> {
  // `locations.name` is not unique - two sites may share a name - so there is no
  // business key to reconcile against and only the cloud identity applies.
  const values = [
    payload.syncId,
    payload.name,
    payload.description,
    payload.status,
  ];
  await upsertMirrored(client, {
    table: "locations",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO locations (sync_id, name, description, status)
                VALUES ($1, $2, $3, $4)`,
    insertValues: values,
    set: "sync_id = $1, name = $2, description = $3, status = $4",
    setValues: values,
    naturalKey: null,
  });
}

async function applyAttendanceNetwork(
  client: PoolClient,
  payload: SyncedAttendanceNetwork
): Promise<void> {
  const values = [
    payload.syncId,
    payload.networkCode,
    payload.name,
    payload.status,
  ];
  await upsertMirrored(client, {
    table: "attendance_networks",
    identityColumn: "sync_id",
    insertSql: `INSERT INTO attendance_networks (sync_id, network_code, name, status)
                VALUES ($1, $2, $3, $4)`,
    insertValues: values,
    set: "sync_id = $1, network_code = $2, name = $3, status = $4",
    setValues: values,
    naturalKey: { columns: ["network_code"], values: [payload.networkCode] },
  });
}

async function applyLecturer(
  client: PoolClient,
  payload: SyncedLecturer
): Promise<void> {
  // Projected, not mirrored: there is no insert into the edge's `lecturers` or
  // `users` table here, and no field of either is copied.
  const values = [
    payload.syncId,
    payload.cloudLecturerId,
    payload.staffId,
    payload.displayName,
    payload.cloudUserId,
    payload.cloudDepartmentSyncId,
  ];
  await upsertMirrored(client, {
    table: "sync_lecturers",
    identityColumn: "cloud_sync_id",
    insertSql: `INSERT INTO sync_lecturers
                  (cloud_sync_id, cloud_lecturer_id, staff_id, display_name,
                   cloud_user_id, cloud_department_sync_id)
                VALUES ($1, $2, $3, $4, $5, $6)`,
    insertValues: values,
    set: `cloud_sync_id = $1, cloud_lecturer_id = $2, staff_id = $3,
          display_name = $4, cloud_user_id = $5,
          cloud_department_sync_id = $6, updated_at = now()`,
    setValues: values,
    naturalKey: {
      columns: ["cloud_lecturer_id"],
      values: [payload.cloudLecturerId],
    },
  });
}

/**
 * Apply one master-data event.
 *
 * `operation` is not branched on: for master data, deactivation is expressed as a
 * status field in the payload (`INACTIVE`, or `is_active = false`), not as a
 * separate operation. `CLOSED` remains exclusive to attendance sessions.
 */
export async function applyMasterDataEvent(
  client: PoolClient,
  event: SyncChangeEvent
): Promise<void> {
  const { entityType } = event;

  // Every payload must have been stamped by a cloud running this same code.
  if (event.payload?.version !== SYNC_PAYLOAD_VERSION) {
    throw new SyncApplyError(
      `Cloud ${entityType} payload version ${
        event.payload?.version ?? "(none)"
      } does not match this edge's version ${SYNC_PAYLOAD_VERSION}.`
    );
  }

  switch (entityType) {
    case "faculty":
      return applyFaculty(client, requirePayload<SyncedFaculty>(entityType, event.payload));
    case "department":
      return applyDepartment(client, requirePayload<SyncedDepartment>(entityType, event.payload));
    case "level":
      return applyLevel(client, requirePayload<SyncedLevel>(entityType, event.payload));
    case "course":
      return applyCourse(client, requirePayload<SyncedCourse>(entityType, event.payload));
    case "academic_session":
      return applyAcademicSession(
        client,
        requirePayload<SyncedAcademicSession>(entityType, event.payload)
      );
    case "semester":
      return applySemester(client, requirePayload<SyncedSemester>(entityType, event.payload));
    case "course_offering":
      return applyCourseOffering(
        client,
        requirePayload<SyncedCourseOffering>(entityType, event.payload)
      );
    case "location":
      return applyLocation(client, requirePayload<SyncedLocation>(entityType, event.payload));
    case "attendance_network":
      return applyAttendanceNetwork(
        client,
        requirePayload<SyncedAttendanceNetwork>(entityType, event.payload)
      );
    case "lecturer":
      return applyLecturer(client, requirePayload<SyncedLecturer>(entityType, event.payload));
    default:
      throw new SyncApplyError(
        `Unsupported sync entity type "${entityType}". The edge cannot advance its cursor past an entity it does not understand.`
      );
  }
}