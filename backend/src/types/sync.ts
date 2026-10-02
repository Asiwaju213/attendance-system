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
  "location",
  "attendance_network",
  "lecturer",
] as const;

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
 * `cloudSessionId`, `cloudCourseOfferingId`, `cloudLecturerId`,
 * `cloudAttendanceNetworkId` and `cloudLocationId` are cloud database identifiers
 * that are meaningless locally. They are carried so the edge can join to those
 * entities once they are synchronized; they are NOT local identities and must
 * never be used to address a local row.
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
  cloudLecturerId: number;
  cloudAttendanceNetworkId: number;
  cloudLocationId: number;
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

export interface SyncedLocation extends SyncedPayloadBase {
  syncId: string;
  cloudLocationId: number;
  name: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
}

export interface SyncedAttendanceNetwork extends SyncedPayloadBase {
  syncId: string;
  cloudAttendanceNetworkId: number;
  networkCode: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
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
  | SyncedLocation
  | SyncedAttendanceNetwork
  | SyncedLecturer;

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