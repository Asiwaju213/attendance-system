import type { PoolClient } from "pg";
import { SYNC_PAYLOAD_VERSION } from "../config/sync";
import { RETIRED_SYNC_ENTITY_TYPES } from "../types/sync";
import type {
  SyncChangeEvent,
  SyncEntityType,
  SyncedAcademicSession,
  SyncedCourse,
  SyncedCourseOffering,
  SyncedCourseRegistration,
  SyncedDepartment,
  SyncedEntityPayload,
  SyncedFaculty,
  SyncedLecturer,
  SyncedLevel,
  SyncedSemester,
  SyncedStudent,
  SyncedStudentDevice,
  SyncedStudentDeviceBootstrap,
} from "../types/sync";
import { SyncApplyError } from "./syncErrors";

/**
 * Applies synchronized master data to the edge database.
 *
 * Two different destinations, and the difference is the whole point of Task 2's
 * scope decision:
 *
 * - The seven reference tables (faculties, departments, levels, courses,
 *   academic_sessions, semesters, course_offerings) are mirrored into the edge's
 *   REAL tables. The edge never authors these rows, so writing the cloud's
 *   authoritative copy in place of an absent local one keeps foreign keys, joins
 *   and existing queries working normally instead of behind a parallel projection.
 *
 * - Lecturers go to the `sync_lecturers` projection instead. A lecturer's
 *   `user_id` points into `users`, and the edge's `users` table is its own
 *   authentication store for local admins and locally-enrolled students.
 *   Writing cloud identity into that table would put cloud-owned identity records
 *   into the edge's login store. The display name is denormalized into the
 *   projection so nothing needs a row in `users` to attribute a session.
 *
 * - Students are mirrored into BOTH real tables (`users` + `students`), because
 *   the edge's attendance queries join them and a projection would leave every
 *   one of those queries to resolve an identity the edge does not have. The
 *   local `users` row is created with `password_hash = NULL`, so a synchronized
 *   student holds no local credential: the row exists for the name, the status
 *   and the foreign keys, not for login.
 *
 * - Course registrations are written into the REAL `course_registrations`
 *   table, the same one the edge's own eligibility queries read and the one the
 *   UNIQUE (student, offering) pair already constrains. The pair resolves
 *   through the mirrored `students` and `course_offerings` rows above, so no
 *   second registration table and no parallel projection is involved.
 *
 * - Device state goes to the `sync_student_devices` projection instead. The
 *   edge's own `student_devices` table holds credentials enrolled LOCALLY, and
 *   mixing cloud-owned device rows into it would make a local credential and a
 *   cloud one indistinguishable - and would put a cloud row in front of the
 *   attendance verification queries. The projection carries the device's
 *   opaque reference, its student and its ACTIVE/REVOKED status: the binding
 *   decision, and nothing credential-shaped. It never creates a student (the
 *   parent must already be mirrored) and never carries a credential id, public
 *   key, counter or discoverable flag, because no payload field holds one.
 *
 * - One-time bootstrap secrets go to `sync_student_device_bootstraps`
 *   (migration 022), which holds the SHA-256 HASH of the secret the student
 *   spends to bind a device - never the secret, which never crosses the
 *   boundary. The row is spendable only once, by the edge's own consume
 *   statement, and this applier refuses every shape that could make it
 *   spendable twice or spendable by the wrong student.
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
  | "students"
  | "course_registrations"
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
   * Bound values for `expressions`, in placeholder order.
   *
   * Used only when `expressions` is set (a business key resolved by SQL
   * expressions rather than bound scalars). Each expression's placeholders
   * consume these in order, continuing after the UPDATE statement's own SET
   * parameters, so `expressions` and `expressionValues` must have equal length.
   */
  expressionValues?: unknown[];
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
 *   `semesters.name`, `courses.course_code` or `academic_sessions.name`. That
 *   aborts the whole apply transaction, so a fresh edge could never synchronize
 *   past its own seed data.
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
      if (
        !key.expressionValues ||
        key.expressionValues.length !== key.expressions.length
      ) {
        throw new SyncApplyError(
          `Natural key for ${spec.table} uses ${key.expressions.length} ` +
            `expressions but carries ${
              key.expressionValues?.length ?? 0
            } bound values.`
        );
      }
      params.push(...key.expressionValues);
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
  "lecturer",
  "student",
  "course_registration",
  "student_device",
  "student_device_bootstrap",
] as const;

export function isMasterDataEntityType(
  entityType: string
): entityType is (typeof MASTER_DATA_ENTITY_TYPES)[number] {
  return (MASTER_DATA_ENTITY_TYPES as readonly string[]).includes(entityType);
}

/**
 * An entity type whose table no longer exists on either side.
 *
 * The cloud's feed is append-only and still holds any `location` or
 * `attendance_network` event it wrote before migration 018 dropped those tables.
 * An edge whose cursor has not reached one of those events must still be able to
 * move forward: the event is claimed (so idempotency and contiguity hold) and
 * counted as applied without writing anything, which is the correct outcome for a
 * row that describes data nobody reads any more.
 *
 * Distinct from the unknown-entity case, which stays fatal on purpose: this edge
 * does not know what that event meant, so advancing past it would lose data.
 */
export function isRetiredEntityType(entityType: string): boolean {
  return (RETIRED_SYNC_ENTITY_TYPES as readonly string[]).includes(entityType);
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
  const courseRef = requireParentRef(
    "course_offering",
    "cloudCourseSyncId",
    payload.cloudCourseSyncId
  );
  const academicSessionRef = requireParentRef(
    "course_offering",
    "cloudAcademicSessionSyncId",
    payload.cloudAcademicSessionSyncId
  );
  const semesterRef = requireParentRef(
    "course_offering",
    "cloudSemesterSyncId",
    payload.cloudSemesterSyncId
  );

  const values = [
    payload.syncId,
    courseRef,
    academicSessionRef,
    semesterRef,
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
    // than bound directly. Placeholders $6-$8 continue after the five above and
    // are bound to the same three parent UUIDs as the SET clause.
    naturalKey: {
      columns: ["course_id", "academic_session_id", "semester_id"],
      expressions: [
        parent("courses", 6),
        parent("academic_sessions", 7),
        parent("semesters", 8),
      ],
      expressionValues: [courseRef, academicSessionRef, semesterRef],
    },
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

/** Account states `users.status` admits (migrations 001 and 005). */
const STUDENT_STATUSES = ["ACTIVE", "INACTIVE", "PENDING"] as const;

/**
 * Mirror the name and account status onto the `users` row a synchronized
 * student points at.
 *
 * The role guard is the "do not merge two unrelated rows" check: `students`
 * has no constraint stopping it from referencing a user that is not a student,
 * and writing cloud identity onto such a row would silently re-home the cloud
 * student onto an unrelated account. Zero rows updated therefore fails the
 * whole batch instead of adopting anything.
 */
async function updateStudentUser(
  client: PoolClient,
  userId: number,
  name: string,
  status: string
): Promise<void> {
  const result = await client.query(
    `UPDATE users SET name = $2, status = $3 WHERE id = $1 AND role = 'STUDENT'`,
    [userId, name, status]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new SyncApplyError(
      `Cloud student references local user ${userId}, which does not own a STUDENT row. ` +
        `Refusing to write cloud identity onto an unrelated account.`
    );
  }
}

/**
 * Write one cloud student into the edge's real `users` + `students` rows.
 *
 * Three attempts, in order - the same shape `upsertMirrored` uses, for the same
 * reason (a fresh edge seeds nothing here, but an edge that already holds the
 * student from before this feature must be adopted rather than duplicated):
 *
 *   1. by `sync_id`: the row already carries the cloud identity, refresh it.
 *   2. by `matric_number`: a pre-existing local student with the same business
 *      key adopts the cloud `sync_id` and keeps its local integer id, so its
 *      `student_devices`, `course_registrations` and attendance history all
 *      stay attached. The local user row is only updated when it really is a
 *      student row, so an accidental match cannot merge two accounts.
 *   3. insert: create the local `users` row (role STUDENT, `password_hash`
 *      NULL - no credential crosses the boundary) and the `students` row
 *      beneath it.
 *
 * Parents are resolved by UUID through `requireParentRef`, so an edge that has
 * not mirrored the department or the level yet fails the batch and holds its
 * cursor instead of writing a row with a NULL foreign key. That failure, and a
 * matric or sync id that is already taken by a different row, are the two ways
 * this applier refuses rather than guessing.
 */
async function applyStudent(
  client: PoolClient,
  payload: SyncedStudent
): Promise<void> {
  const matricNumber =
    typeof payload.matricNumber === "string" ? payload.matricNumber.trim() : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (matricNumber === "" || name === "") {
    throw new SyncApplyError(
      "Cloud student payload is missing its matricNumber or name."
    );
  }
  const status = payload.status;
  if (!STUDENT_STATUSES.includes(status)) {
    throw new SyncApplyError(
      `Cloud student payload carries unsupported status "${String(payload.status)}".`
    );
  }
  const departmentRef = requireParentRef(
    "student",
    "cloudDepartmentSyncId",
    payload.cloudDepartmentSyncId
  );
  const levelRef = requireParentRef(
    "student",
    "cloudLevelSyncId",
    payload.cloudLevelSyncId
  );

  try {
    const bySyncId = await client.query(
      `UPDATE students
          SET matric_number = $2,
              department_id = ${parent("departments", 3)},
              level_id = ${parent("levels", 4)}
        WHERE sync_id = $1
        RETURNING id, user_id`,
      [payload.syncId, matricNumber, departmentRef, levelRef]
    );
    if ((bySyncId.rowCount ?? 0) > 0) {
      await updateStudentUser(
        client,
        Number(bySyncId.rows[0].user_id),
        name,
        status
      );
      return;
    }

    const byMatric = await client.query(
      `UPDATE students
          SET sync_id = $1,
              department_id = ${parent("departments", 3)},
              level_id = ${parent("levels", 4)}
        WHERE matric_number = $2
        RETURNING id, user_id`,
      [payload.syncId, matricNumber, departmentRef, levelRef]
    );
    if ((byMatric.rowCount ?? 0) > 0) {
      await updateStudentUser(
        client,
        Number(byMatric.rows[0].user_id),
        name,
        status
      );
      return;
    }

    const insertedUser = await client.query(
      `INSERT INTO users (name, role, status, password_hash)
       VALUES ($1, 'STUDENT', $2, NULL)
       RETURNING id`,
      [name, status]
    );
    await client.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id, sync_id)
       VALUES ($1, $2, ${parent("departments", 3)}, ${parent("levels", 4)}, $5)`,
      [
        Number(insertedUser.rows[0].id),
        matricNumber,
        departmentRef,
        levelRef,
        payload.syncId,
      ]
    );
  } catch (error) {
    // A unique violation here means two rows already disagree about who this
    // student is: the matric number is taken by another local student, or the
    // cloud identity is already attached to a different matric. Either way the
    // choice between the rows is a human decision, so the batch fails and the
    // cursor holds rather than one row silently winning.
    if ((error as { code?: string }).code === "23505") {
      throw new SyncApplyError(
        `Cloud student ${matricNumber} collides with an existing local student ` +
          `identity (matric number or sync_id already in use). Refusing to guess ` +
          `which local row is the same student.`
      );
    }
    throw error;
  }
}

/** Statuses the `course_registrations` CHECK constraint admits. */
const REGISTRATION_STATUSES = ["ENROLLED", "DROPPED", "COMPLETED"] as const;

/**
 * Write one cloud course registration into the edge's real
 * `course_registrations` row.
 *
 * Three attempts, in order - the same shape `upsertMirrored` uses, for the
 * reason it exists:
 *
 *   1. by `sync_id`: the row already carries the cloud identity, so this is a
 *      refresh of the pair and the status (a re-delivered event, or a
 *      registration whose pair was re-homed in the cloud).
 *   2. by the natural key `(student_id, course_offering_id)`: an edge that
 *      already registered this student for this offering - written locally, or
 *      mirrored by an earlier event - ADOPTS the cloud `sync_id` and keeps its
 *      local integer id, so attendance history and eligibility queries pointing
 *      at the row stay attached. The pair is resolved from the parent UUIDs
 *      through `parent()`, exactly like the SET clause, so both match paths
 *      agree on which local ids the UUIDs mean.
 *   3. insert: a new registration, with both parents resolved by UUID.
 *
 * A missing parent is a NOT NULL foreign-key failure inside these statements;
 * `applyChangeBatch` turns that into the named "referenced parent" error and
 * holds the cursor, so no row is ever written with a NULL foreign key. A unique
 * violation that survives both match paths means two local rows disagree about
 * which one this registration is - the ambiguity test's case - and is refused
 * rather than guessed, exactly as `applyStudent` refuses its own collision.
 *
 * The operation is not branched on: a DROPPED or COMPLETED registration is
 * carried as a status in the payload, not as a delete. The local row is never
 * removed, because attendance history references it - the same rule students
 * follow.
 */
async function applyCourseRegistration(
  client: PoolClient,
  payload: SyncedCourseRegistration
): Promise<void> {
  const status = payload.status;
  if (!REGISTRATION_STATUSES.includes(status)) {
    throw new SyncApplyError(
      `Cloud course registration payload carries unsupported status "${String(
        payload.status
      )}".`
    );
  }
  const studentRef = requireParentRef(
    "course_registration",
    "cloudStudentSyncId",
    payload.cloudStudentSyncId
  );
  const offeringRef = requireParentRef(
    "course_registration",
    "cloudCourseOfferingSyncId",
    payload.cloudCourseOfferingSyncId
  );

  try {
    await upsertMirrored(client, {
      table: "course_registrations",
      identityColumn: "sync_id",
      insertSql: `INSERT INTO course_registrations
                    (sync_id, student_id, course_offering_id, status)
                  VALUES ($1, ${parent("students", 2)},
                          ${parent("course_offerings", 3)}, $4)`,
      insertValues: [payload.syncId, studentRef, offeringRef, status],
      set: `sync_id = $1,
            student_id = ${parent("students", 2)},
            course_offering_id = ${parent("course_offerings", 3)},
            status = $4`,
      setValues: [payload.syncId, studentRef, offeringRef, status],
      // The business key is the (student, offering) pair, and its values are
      // LOCAL ids resolved from the cloud UUIDs. Placeholders $5-$6 continue
      // after the four above and are bound to the same two parent UUIDs the
      // SET clause uses, so both statements resolve the pair identically.
      naturalKey: {
        columns: ["student_id", "course_offering_id"],
        expressions: [parent("students", 5), parent("course_offerings", 6)],
        expressionValues: [studentRef, offeringRef],
      },
    });
  } catch (error) {
    // A unique violation here means two local rows already disagree about which
    // one this cloud registration is: the sync_id is attached to a different
    // pair, or the pair is held by a row with a different identity, and
    // re-homing one of them would collide with the other. Which row is the
    // same registration is a human decision, so the batch fails and the cursor
    // holds rather than one row silently winning.
    if ((error as { code?: string }).code === "23505") {
      throw new SyncApplyError(
        `Cloud course registration ${payload.syncId} collides with an existing ` +
          `local registration (sync_id or the (student, offering) pair is already ` +
          `in use by a different row). Refusing to guess which local row is the ` +
          `same registration.`
      );
    }
    throw error;
  }
}

/** Statuses the `sync_student_devices` CHECK constraint admits. */
const STUDENT_DEVICE_STATUSES = ["ACTIVE", "REVOKED"] as const;

/** Statuses the `sync_student_device_bootstraps` CHECK constraint admits. */
const STUDENT_DEVICE_BOOTSTRAP_STATUSES = ["PENDING", "CONSUMED"] as const;

/**
 * Write one cloud device-state event into the edge's `sync_student_devices`
 * projection.
 *
 * Three attempts, in order - the shape `upsertMirrored` uses, for the reason it
 * exists - with two refusal checks the other appliers do not need:
 *
 *   1. by `sync_id`: the replica row already carries the cloud identity, so
 *      this is a status refresh of the same device.
 *   2. by the natural key `cloud_device_ref`: an edge that already holds this
 *      device under a different identity adopts the cloud's `sync_id` onto the
 *      same row instead of duplicating it.
 *   3. insert: a new replica row, with the student resolved by UUID.
 *
 * Both match paths are read before anything is written, and the STUDENT is
 * checked on whichever row matches: a device never changes owner, so an event
 * that would move an existing replica row onto a different student is refused
 * rather than re-homed. Two rows matching means the edge already disagrees
 * about which replica row this event is, which is refused the same way a
 * registration pair collision is.
 *
 * The one-active invariant is enforced explicitly, before any write: a status
 * ACTIVE event for a student who already holds a DIFFERENT ACTIVE replica row
 * is refused. The cloud revokes a device before replacing it inside one
 * transaction, so the feed cannot arrive in the other order under normal
 * operation - but installing a second active binding would break exactly the
 * rule the whole design rests on, so an inconsistent feed stops the cursor for
 * a human instead of silently picking a winner. The partial unique index
 * `one_active_sync_student_device_per_student` is the database-level backstop.
 *
 * A missing parent fails before any row is written: the student is resolved by
 * UUID first, and this applier never creates one (unlike `applyStudent`,
 * which may), so a device whose student has not synchronized yet holds the
 * cursor rather than dangling or conjuring an identity.
 *
 * The operation is not branched on: REVOKED is a status in the payload, not a
 * delete. The replica row is never removed, so a re-delivered revocation
 * resolves to the same row and a revoked device stays auditable.
 */
async function applyStudentDevice(
  client: PoolClient,
  payload: SyncedStudentDevice
): Promise<void> {
  const status = payload.status;
  if (!STUDENT_DEVICE_STATUSES.includes(status)) {
    throw new SyncApplyError(
      `Cloud student device payload carries unsupported status "${String(
        payload.status
      )}".`
    );
  }
  const studentRef = requireParentRef(
    "student_device",
    "cloudStudentSyncId",
    payload.cloudStudentSyncId
  );
  if (typeof payload.cloudDeviceRef !== "string" || payload.cloudDeviceRef === "") {
    throw new SyncApplyError(
      "Cloud student device payload is missing its cloudDeviceRef reference."
    );
  }

  const resolved = await client.query(
    `SELECT id FROM students WHERE sync_id = $1`,
    [studentRef]
  );
  if ((resolved.rowCount ?? 0) === 0) {
    // Phrased the same way `applyChangeBatch` phrases the foreign-key failure,
    // so an operator sees one diagnosis for "the parent is not here" no matter
    // which applier hit it.
    throw new SyncApplyError(
      `Cannot apply cloud student device ${payload.syncId}: a referenced parent ` +
        `(student ${studentRef}) is not present on this edge. ` +
        `The cloud emits a student's CREATED event before anything that references it, ` +
        `so this normally means the edge cursor was advanced past it.`
    );
  }
  const studentId = Number(resolved.rows[0].id);

  const bySyncId = await client.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id
       FROM sync_student_devices WHERE cloud_sync_id = $1`,
    [payload.syncId]
  );
  const byDeviceRef = await client.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id
       FROM sync_student_devices WHERE cloud_device_ref = $1`,
    [payload.cloudDeviceRef]
  );

  const matched =
    (bySyncId.rowCount ?? 0) > 0
      ? bySyncId.rows[0]
      : (byDeviceRef.rowCount ?? 0) > 0
        ? byDeviceRef.rows[0]
        : null;

  if (
    matched !== null &&
    (bySyncId.rowCount ?? 0) > 0 &&
    (byDeviceRef.rowCount ?? 0) > 0 &&
    bySyncId.rows[0].cloud_sync_id !== byDeviceRef.rows[0].cloud_sync_id
  ) {
    throw new SyncApplyError(
      `Cloud student device ${payload.syncId} collides with an existing local replica ` +
        `(its sync_id and its device reference are held by different rows). ` +
        `Refusing to guess which local row is the same device.`
    );
  }
  if (matched !== null && Number(matched.student_id) !== studentId) {
    throw new SyncApplyError(
      `Cloud student device ${payload.syncId} resolves to a local replica row belonging to a different student. ` +
        `A device never changes owner; refusing to re-home it.`
    );
  }

  if (status === "ACTIVE") {
    // Excluding the matched row by its cloud identity (the table's primary
    // key) rather than a local integer: the projection has no local identity,
    // and a status refresh of this same device must not read itself as a
    // second active binding.
    const conflict = await client.query(
      `SELECT 1 FROM sync_student_devices
        WHERE student_id = $1 AND status = 'ACTIVE'
          AND ($2::uuid IS NULL OR cloud_sync_id <> $2)
        LIMIT 1`,
      [studentId, matched === null ? null : (matched.cloud_sync_id as string)]
    );
    if ((conflict.rowCount ?? 0) > 0) {
      throw new SyncApplyError(
        `Cloud student device ${payload.syncId} would make a second device ACTIVE for student ${studentRef}, ` +
          `but this edge already holds a different ACTIVE device for them. The cloud revokes a device before ` +
          `replacing it, so this event is out of order; refusing to pick one.`
      );
    }
  }

  try {
    if (matched !== null) {
      // Both cloud identities come from the payload, keyed by the row's
      // CURRENT cloud sync id (its primary key). On the sync-id path the first
      // assignment is a no-op; on the device-reference path it is the adoption
      // itself - an edge that already held this device under another identity
      // keeps its row and takes the cloud's.
      await client.query(
        `UPDATE sync_student_devices
            SET cloud_sync_id = $2,
                cloud_device_ref = $3,
                student_id = $4,
                cloud_student_sync_id = $5,
                status = $6
          WHERE cloud_sync_id = $1`,
        [
          matched.cloud_sync_id as string,
          payload.syncId,
          payload.cloudDeviceRef,
          studentId,
          studentRef,
          status,
        ]
      );
      return;
    }

    await client.query(
      `INSERT INTO sync_student_devices
         (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [payload.syncId, payload.cloudDeviceRef, studentId, studentRef, status]
    );
  } catch (error) {
    // A unique violation here means two replica rows already disagree about
    // which one this cloud device is - the sync id, the device reference or the
    // one-ACTIVE-device rule is held by another row. Which row is the same
    // device is a human decision, so the batch fails and the cursor holds
    // rather than one row silently winning.
    if ((error as { code?: string }).code === "23505") {
      throw new SyncApplyError(
        `Cloud student device ${payload.syncId} collides with an existing local replica ` +
          `(sync_id, device reference or the one-active-device rule is already in use by another row). ` +
          `Refusing to guess which local row is the same device.`
      );
    }
    throw error;
  }
}

/**
 * Write one one-time bootstrap event into `sync_student_device_bootstraps`.
 *
 * Same three-attempt shape as `applyStudentDevice` above: by cloud sync id,
 * then by the natural key `cloud_device_ref`, with the same collision refusal
 * if the two ever disagree - plus three rules of its own, because this row is
 * spendable credential material rather than state:
 *
 *   1. The parent device must already be in the `sync_student_devices`
 *      projection. The cloud emits the device's CREATED event before it mints
 *      any secret for that device, so a bootstrap arriving first means the
 *      cursor was advanced past the device - the cursor holds, exactly as for a
 *      missing student, rather than storing a secret bound to a device this
 *      edge cannot check.
 *
 *   2. The device must belong to the resolved student. The consume statement
 *      joins the device projection to the student, so a bootstrap whose two
 *      references point at different students could never be spent - and
 *      storing it anyway would leave a row that looks spendable to a reader.
 *
 *   3. CONSUMED is never regressed. The cloud only ever emits PENDING (it is
 *      never told of consumption), so a PENDING event over a CONSUMED row is
 *      either a re-delivery or an out-of-order replay of the original mint.
 *      Either way the secret is already spent: the status update skips both
 *      `status` and `consumed_at`, keeping the row exactly as the edge left
 *      it. A spent secret must not become spendable again by being delivered
 *      twice.
 *
 * An expired row is stored, not refused: expiry is checked at consume time
 * against the clock, and refusing to store would turn "this secret is no
 * longer valid" into a cursor the operator has to unpick by hand.
 */
async function applyStudentDeviceBootstrap(
  client: PoolClient,
  payload: SyncedStudentDeviceBootstrap
): Promise<void> {
  const status = payload.status;
  if (!STUDENT_DEVICE_BOOTSTRAP_STATUSES.includes(status)) {
    throw new SyncApplyError(
      `Cloud student device bootstrap payload carries unsupported status "${String(
        payload.status
      )}".`
    );
  }
  const studentRef = requireParentRef(
    "student_device_bootstrap",
    "cloudStudentSyncId",
    payload.cloudStudentSyncId
  );
  if (
    typeof payload.cloudDeviceRef !== "string" ||
    payload.cloudDeviceRef === ""
  ) {
    throw new SyncApplyError(
      "Cloud student device bootstrap payload is missing its cloudDeviceRef reference."
    );
  }
  if (typeof payload.secretHash !== "string" || payload.secretHash === "") {
    throw new SyncApplyError(
      "Cloud student device bootstrap payload is missing its secretHash."
    );
  }
  if (
    typeof payload.expiresAt !== "string" ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new SyncApplyError(
      "Cloud student device bootstrap payload carries an unreadable expiresAt."
    );
  }

  const resolved = await client.query(
    `SELECT id FROM students WHERE sync_id = $1`,
    [studentRef]
  );
  if ((resolved.rowCount ?? 0) === 0) {
    throw new SyncApplyError(
      `Cannot apply cloud student device bootstrap ${payload.syncId}: a referenced parent ` +
        `(student ${studentRef}) is not present on this edge. ` +
        `The cloud emits a student's CREATED event before anything that references it, ` +
        `so this normally means the edge cursor was advanced past it.`
    );
  }
  const studentId = Number(resolved.rows[0].id);

  const device = await client.query(
    `SELECT cloud_sync_id, student_id
       FROM sync_student_devices WHERE cloud_device_ref = $1`,
    [payload.cloudDeviceRef]
  );
  if ((device.rowCount ?? 0) === 0) {
    throw new SyncApplyError(
      `Cannot apply cloud student device bootstrap ${payload.syncId}: a referenced parent ` +
        `(device ${payload.cloudDeviceRef}) is not present on this edge. ` +
        `The cloud emits a device's CREATED event before minting any secret for it, ` +
        `so this normally means the edge cursor was advanced past it.`
    );
  }
  if (Number(device.rows[0].student_id) !== studentId) {
    throw new SyncApplyError(
      `Cloud student device bootstrap ${payload.syncId} binds device ${payload.cloudDeviceRef} ` +
        `to student ${studentRef}, but this edge holds that device for a different student. ` +
        `A secret can only unlock the device it was minted for; refusing to store it.`
    );
  }

  const bySyncId = await client.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id, status
       FROM sync_student_device_bootstraps WHERE cloud_sync_id = $1`,
    [payload.syncId]
  );
  const byDeviceRef = await client.query(
    `SELECT cloud_sync_id, cloud_device_ref, student_id, status
       FROM sync_student_device_bootstraps WHERE cloud_device_ref = $1`,
    [payload.cloudDeviceRef]
  );

  const matched =
    (bySyncId.rowCount ?? 0) > 0
      ? bySyncId.rows[0]
      : (byDeviceRef.rowCount ?? 0) > 0
        ? byDeviceRef.rows[0]
        : null;

  if (
    matched !== null &&
    (bySyncId.rowCount ?? 0) > 0 &&
    (byDeviceRef.rowCount ?? 0) > 0 &&
    bySyncId.rows[0].cloud_sync_id !== byDeviceRef.rows[0].cloud_sync_id
  ) {
    throw new SyncApplyError(
      `Cloud student device bootstrap ${payload.syncId} collides with an existing local replica ` +
        `(its sync_id and its device reference are held by different rows). ` +
        `Refusing to guess which local row is the same bootstrap.`
    );
  }
  if (matched !== null && Number(matched.student_id) !== studentId) {
    throw new SyncApplyError(
      `Cloud student device bootstrap ${payload.syncId} resolves to a local replica row belonging to a different student. ` +
        `A bootstrap never changes owner; refusing to re-home it.`
    );
  }

  try {
    if (matched !== null) {
      // Both cloud identities come from the payload, keyed by the row's
      // CURRENT cloud sync id (its primary key). On the sync-id path the first
      // assignment is a no-op; on the device-reference path it is the adoption
      // itself - an edge that already held this bootstrap under another
      // identity keeps its row and takes the cloud's.
      //
      // CONSUMED is never regressed: the CASE keeps a spent row spent even
      // when the replayed event says PENDING, and keeps `consumed_at` intact
      // so the paired CHECK constraint holds.
      await client.query(
        `UPDATE sync_student_device_bootstraps
            SET cloud_sync_id = $2,
                cloud_device_ref = $3,
                student_id = $4,
                cloud_student_sync_id = $5,
                secret_hash = $6,
                status = CASE WHEN status = 'CONSUMED' THEN status ELSE $7 END,
                consumed_at = CASE WHEN status = 'CONSUMED'
                                   THEN consumed_at ELSE NULL END,
                expires_at = $8
          WHERE cloud_sync_id = $1`,
        [
          matched.cloud_sync_id as string,
          payload.syncId,
          payload.cloudDeviceRef,
          studentId,
          studentRef,
          payload.secretHash,
          status,
          payload.expiresAt,
        ]
      );
      return;
    }

    await client.query(
      `INSERT INTO sync_student_device_bootstraps
         (cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id,
          secret_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        payload.syncId,
        payload.cloudDeviceRef,
        studentId,
        studentRef,
        payload.secretHash,
        status,
        payload.expiresAt,
      ]
    );
  } catch (error) {
    // A unique violation here means two replica rows already disagree about
    // which one this cloud bootstrap is - the sync id or the device reference
    // is held by another row (at most one bootstrap per device, by design).
    // Which row is the same bootstrap is a human decision, so the batch fails
    // and the cursor holds rather than one row silently winning.
    if ((error as { code?: string }).code === "23505") {
      throw new SyncApplyError(
        `Cloud student device bootstrap ${payload.syncId} collides with an existing local replica ` +
          `(sync_id or device reference is already in use by another row). ` +
          `Refusing to guess which local row is the same bootstrap.`
      );
    }
    throw error;
  }
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
    // A location or attendance_network event can only be a row the cloud wrote
    // before its table was dropped by migration 018. The caller retires those
    // without applying them; if one reaches here the entityType is not one this
    // edge knows, so it is refused rather than silently discarded.
    case "lecturer":
      return applyLecturer(client, requirePayload<SyncedLecturer>(entityType, event.payload));
    case "student":
      return applyStudent(client, requirePayload<SyncedStudent>(entityType, event.payload));
    case "course_registration":
      return applyCourseRegistration(
        client,
        requirePayload<SyncedCourseRegistration>(entityType, event.payload)
      );
    case "student_device":
      return applyStudentDevice(
        client,
        requirePayload<SyncedStudentDevice>(entityType, event.payload)
      );
    case "student_device_bootstrap":
      return applyStudentDeviceBootstrap(
        client,
        requirePayload<SyncedStudentDeviceBootstrap>(entityType, event.payload)
      );
    default:
      throw new SyncApplyError(
        `Unsupported sync entity type "${entityType}". The edge cannot advance its cursor past an entity it does not understand.`
      );
  }
}