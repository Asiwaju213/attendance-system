/**
 * Shapes for cloud -> local K12 edge synchronization.
 *
 * The vocabulary here ("event", "cursor", "entity") is deliberately generic. Task 1
 * only synchronizes attendance sessions, but nothing in these types mentions a
 * session except the payload, so adding a second synchronized entity later is a
 * payload and an applier rather than a new transport.
 */

export const SYNC_OPERATIONS = ["CREATED", "UPDATED", "CLOSED"] as const;

export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

/**
 * Entity namespaces that may appear in the feed.
 *
 * Kept as a const tuple rather than a free string so a typo in a new emitter is a
 * TypeScript error instead of an event the edge silently refuses forever.
 */
export const SYNC_ENTITY_TYPES = [
  "attendance_session",
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

/**
 * Entity types that used to be synchronized and no longer exist.
 *
 * The `attendance_networks` and `locations` tables are dropped by migration 018;
 * nothing writes an event for them any more. Rows already in the cloud's
 * append-only feed are kept, because `sync_change_events.entity_type` is plain
 * TEXT with no check constraint and the feed is never rewritten.
 *
 * An edge whose cursor has not yet reached one of those events must be able to
 * drain past it, so these names stay recognized on the receiving side and are
 * retired as they are claimed. Deleting them from the list above is what stops
 * any new event from being produced.
 */
export const RETIRED_SYNC_ENTITY_TYPES = ["location", "attendance_network"] as const;

export type RetiredSyncEntityType = (typeof RETIRED_SYNC_ENTITY_TYPES)[number];

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/**
 * Every payload carries `version`, so a later task can change a payload's shape
 * without the edge misreading an old event as a new one.
 */
export interface SyncedPayloadBase {
  version: number;
}

/**
 * The synchronized state of one cloud attendance session.
 *
 * This is the complete local projection of the session, not a partial patch, so
 * an edge can apply any single event without having seen the ones before it.
 *
 * `cloudSessionId`, `cloudCourseOfferingId` and `cloudLecturerId` are cloud database identifiers
 * that are meaningless locally. They are carried so the edge can join to those
 * entities once they are synchronized; they are NOT local identities and must
 * never be used to address a local row.
 *
 * `cloudCourseOfferingSyncId` is the exception that makes a cloud session markable
 * on the edge (Task 4): it is the cloud's `course_offerings.sync_id` UUID, the only
 * identity that means the same thing on both databases, and it is what the edge
 * joins the projection to its LOCAL `course_offerings` row with. It is written by
 * the apply service from the feed and is never read from a client request.
 *
 * `lecturerDisplayName` and `lecturerStaffId` are denormalized so the edge can
 * show who owns a session without holding any row in its `users` table (see
 * migration 013).
 *
 * Deliberately absent: any student identifier, password hash, session
 * material, WebAuthn credential or device credential id.
 */
export interface SyncedAttendanceSession extends SyncedPayloadBase {
  syncId: string;
  cloudSessionId: number;
  cloudCourseOfferingId: number;
  cloudCourseOfferingSyncId: string;
  cloudLecturerId: number;
  courseCode: string;
  courseTitle: string;
  lecturerDisplayName: string;
  lecturerStaffId: string;
  startTime: string;
  endTime: string;
  lateThresholdMinutes: number;
  status: "ACTIVE" | "ENDED";
  endedAt: string | null;
}

/**
 * Master data mirrored into the edge's real local tables.
 *
 * Each carries the cloud UUID (`syncId`) as the cross-database identity plus the
 * cloud's integer id for diagnostics and for joining to entities that are still
 * cloud-scoped. Parent references are cloud UUIDs so the edge can resolve them
 * against its own rows without depending on either sequence.
 */
export interface SyncedFaculty extends SyncedPayloadBase {
  syncId: string;
  cloudFacultyId: number;
  name: string;
  code: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface SyncedDepartment extends SyncedPayloadBase {
  syncId: string;
  cloudDepartmentId: number;
  name: string;
  code: string;
  status: "ACTIVE" | "INACTIVE";
  cloudFacultySyncId: string;
}

export interface SyncedLevel extends SyncedPayloadBase {
  syncId: string;
  cloudLevelId: number;
  /** Restricted by a CHECK constraint to 100, 200, 300, 400 or 500. */
  name: number;
}

export interface SyncedCourse extends SyncedPayloadBase {
  syncId: string;
  cloudCourseId: number;
  courseCode: string;
  title: string;
  status: "ACTIVE" | "INACTIVE";
  /**
   * A course belongs to exactly one faculty or one department, never both and
   * never neither (CHECK `chk_courses_single_owner`). At most one of these is set.
   */
  cloudDepartmentSyncId: string | null;
  cloudFacultySyncId: string | null;
  cloudLevelSyncId: string;
}

export interface SyncedAcademicSession extends SyncedPayloadBase {
  syncId: string;
  cloudAcademicSessionId: number;
  name: string;
  isActive: boolean;
}

export interface SyncedSemester extends SyncedPayloadBase {
  syncId: string;
  cloudSemesterId: number;
  /** Restricted by a CHECK constraint to the two semester literals. */
  name: string;
}

export interface SyncedCourseOffering extends SyncedPayloadBase {
  syncId: string;
  cloudCourseOfferingId: number;
  status: "OPEN" | "CLOSED";
  cloudCourseSyncId: string;
  cloudAcademicSessionSyncId: string;
  cloudSemesterSyncId: string;
}

/**
 * A cloud lecturer, projected rather than mirrored.
 *
 * The edge never receives a row in `users`, so there is no `passwordHash`,
 * `username`, email or WebAuthn handle anywhere in this payload. `displayName`
 * is copied from `users.name` so sessions can be attributed without identity.
 */
export interface SyncedLecturer extends SyncedPayloadBase {
  syncId: string;
  cloudLecturerId: number;
  staffId: string;
  displayName: string;
  cloudUserId: number;
  cloudDepartmentSyncId: string | null;
}

/**
 * The synchronized state of one cloud student.
 *
 * Mirrored into the edge's real `users` + `students` rows, so the payload
 * carries exactly what those two rows are made of and nothing else: the stable
 * `syncId` from `students.sync_id`, the business key (`matricNumber`), the
 * display name and account status from `users`, and the two parent references
 * the edge resolves by UUID.
 *
 * Deliberately absent, and asserted absent by the tests: `passwordHash`,
 * `username`, `webauthnUserHandle`, every WebAuthn credential field
 * (`credentialId`, `publicKey`, `counter`, `challenge`), device binding
 * material and remembered-account tokens. The edge creates its own local
 * credential state (`password_hash = NULL`, a locally generated
 * `webauthn_user_handle`), so nothing here can become an authentication secret
 * on the second database.
 *
 * `status` mirrors `users.status`, which migrations 001/005 restrict to these
 * three values. Inactivity is carried as state rather than as a delete: an
 * inactive student keeps the local row because attendance history references
 * it.
 */
export interface SyncedStudent extends SyncedPayloadBase {
  syncId: string;
  cloudStudentId: number;
  matricNumber: string;
  name: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING";
  cloudDepartmentSyncId: string;
  cloudLevelSyncId: string;
}

/**
 * The synchronized state of one cloud course registration.
 *
 * A registration is the pair (student, course offering) plus its status, so
 * the payload carries the two parents as cloud UUID references the edge
 * resolves against its own `students` and `course_offerings` rows, and the
 * registration's own `syncId` (`course_registrations.sync_id`) as the identity
 * the edge upserts against.
 *
 * `cloudRegistrationId` is the cloud's integer id, carried for diagnostics
 * only; it is never treated as a local identity. Deliberately absent, and
 * asserted absent by the tests: any identifier of the student beyond the parent
 * reference (matric number, name), any password/session/WebAuthn/device field,
 * and any credential material - none of which exists in a registration row.
 */
export interface SyncedCourseRegistration extends SyncedPayloadBase {
  syncId: string;
  cloudRegistrationId: number;
  cloudStudentSyncId: string;
  cloudCourseOfferingSyncId: string;
  /** Restricted by the `course_registrations` CHECK constraint to these three. */
  status: "ENROLLED" | "DROPPED" | "COMPLETED";
}

/**
 * The synchronized state of one cloud device binding.
 *
 * The whole point of this payload is what it is NOT: it carries no credential.
 * No credential id, no public key, no counter, no transports, no AAGUID, no
 * discoverable flag, no challenge and no cookie or session material - none of
 * those fields exist on a `student_devices` row that the emitter selects, so
 * none of them can enter the feed. What crosses the boundary is a device
 * STATE: this opaque device reference, for that student, ACTIVE or REVOKED.
 *
 * `cloudDeviceRef` is the device's stable opaque identity (migration 021). It
 * is what a device-binding cookie may carry and what the edge resolves against
 * its `sync_student_devices` replica - the minimum a login needs to answer
 * "does this browser still hold a binding for an ACTIVE device of this
 * student" without either database ever exchanging a WebAuthn credential.
 *
 * `syncId` is the device row's own cross-database identity
 * (`student_devices.sync_id`), which the edge upserts against so a
 * re-delivered or status-changed event resolves to the same replica row.
 * `cloudStudentSyncId` is the parent reference the edge resolves against its
 * mirrored `students` rows; a device event never creates a student.
 */
export interface SyncedStudentDevice extends SyncedPayloadBase {
  syncId: string;
  cloudDeviceRef: string;
  cloudStudentSyncId: string;
  /** Restricted by the `sync_student_devices` CHECK constraint to these two. */
  status: "ACTIVE" | "REVOKED";
}

/**
 * The synchronized state of one one-time device bootstrap secret.
 *
 * What crosses the boundary here is a SHA-256 hash and nothing else. The
 * plaintext secret exists in exactly one place for its whole life: the HTTP
 * response body of the cloud's enrollment completion, which the student
 * immediately spends on the edge. It is never stored, never logged, never
 * audited and never synchronized - only its hash is, because the edge must be
 * able to recognize the plaintext the student types without ever holding it.
 *
 * `cloudDeviceRef` and `cloudStudentSyncId` bind the secret to one device of
 * one student (migration 022), so a hash can only ever unlock the binding it
 * was minted for. `status` is PENDING at emission - the cloud only ever learns
 * of a secret's birth, never its consumption, because sync is one-directional.
 *
 * Deliberately absent, and asserted absent by the tests: the plaintext itself,
 * any password or session material, any WebAuthn credential field, and the
 * resolved local student id (the edge derives that from `cloudStudentSyncId`).
 */
export interface SyncedStudentDeviceBootstrap extends SyncedPayloadBase {
  syncId: string;
  cloudDeviceRef: string;
  cloudStudentSyncId: string;
  /** SHA-256 hex of the one-time secret. Never the secret itself. */
  secretHash: string;
  /** Restricted by the `sync_student_device_bootstraps` CHECK constraint. */
  status: "PENDING" | "CONSUMED";
  expiresAt: string;
}

/**
 * Union of every payload the feed may carry.
 *
 * The applier dispatches on `entityType` and narrows this union, so adding an
 * entity type without teaching the edge to apply it is a compile-time error.
 */
export type SyncedEntityPayload =
  | SyncedAttendanceSession
  | SyncedFaculty
  | SyncedDepartment
  | SyncedLevel
  | SyncedCourse
  | SyncedAcademicSession
  | SyncedSemester
  | SyncedCourseOffering
  | SyncedLecturer
  | SyncedStudent
  | SyncedCourseRegistration
  | SyncedStudentDevice
  | SyncedStudentDeviceBootstrap;

/**
 * One entry in the cloud's append-only change feed.
 *
 * `cursor` is the feed position and the only ordering authority. Events must be
 * applied in ascending cursor order; `eventId` is the delivery-identity used for
 * idempotency, and is unique across the whole feed.
 */
export interface SyncChangeEvent<T extends SyncedEntityPayload = SyncedEntityPayload> {
  eventId: string;
  cursor: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: T;
  recordedAt: string;
}

/**
 * One bounded page of the feed.
 *
 * `nextCursor` is the cursor of the last event in `events`, or the requested
 * cursor when the page is empty, so an edge can always advance or hold without
 * inspecting the array. `hasMore` tells the worker whether to immediately ask
 * again instead of waiting out its interval.
 */
export interface SyncChangesBatch {
  events: SyncChangeEvent[];
  nextCursor: number;
  hasMore: boolean;
}

/**
 * Observable state of the local sync worker.
 *
 * Carries no credential material of any kind, so it is safe to surface through an
 * internal endpoint later without a second review.
 */
export interface SyncWorkerStatus {
  enabled: boolean;
  running: boolean;
  consumerId: string | null;
  lastCursor: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}