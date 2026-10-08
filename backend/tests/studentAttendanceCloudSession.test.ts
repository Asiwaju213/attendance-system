// MUST be the first import: it sets SYNC_PROVIDER_SECRET_HASH in the environment
// before `config/sync` is evaluated, so the in-process "cloud" accepts the edge
// secret used by the uploader proof below.
import { TEST_EDGE_SECRET } from "./syncTestFixtures";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { webauthnConfig } from "../src/config/webauthn";
import { pool } from "../src/db/pool";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";
import { applyChangeBatch } from "../src/services/syncApplyService";
import { uploadPendingAttendanceMarks } from "../src/services/syncAttendanceUploader";
import {
  SYNC_ATTENDANCE_SESSION_VERSION,
  type SyncConsumerConfig,
} from "../src/config/sync";
import type { SyncChangeEvent, SyncOperation } from "../src/types/sync";
import { boundDeviceHeaders } from "./studentSessionTestHelpers";
import {
  buildAuthenticationResponse,
  createTestAuthenticator,
  type TestAuthenticator,
} from "./webauthnTestHelpers";

const TEST_PASSWORD = "scss-test-password";
const ADMIN_USERNAME = "scss_admin";

const STUDENT_A_MATRIC = "SCSS/STU/A";
const STUDENT_B_MATRIC = "SCSS/STU/B";

// The cloud-side identities this suite exercises. Each is a real UUID that stands
// in for a cloud session whose CREATED/CLOSED events the edge would have applied
// into `sync_attendance_sessions`.
const CLOUD_ACTIVE_1 = randomUUID();
const CLOUD_ACTIVE_2 = randomUUID();
const CLOUD_CLOSED_OFFERING = randomUUID();
const CLOUD_INACTIVE_COURSE = randomUUID();
const CLOUD_ENDED = randomUUID();
const CLOUD_EXPIRED = randomUUID();
const CLOUD_UNREGISTERED = randomUUID();
const CLOUD_UNKNOWN_LINK = randomUUID();
const CLOUD_NULL_LINK = randomUUID();

const ALL_CLOUD_SYNC_IDS = () => [
  CLOUD_ACTIVE_1,
  CLOUD_ACTIVE_2,
  CLOUD_CLOSED_OFFERING,
  CLOUD_INACTIVE_COURSE,
  CLOUD_ENDED,
  CLOUD_EXPIRED,
  CLOUD_UNREGISTERED,
  CLOUD_UNKNOWN_LINK,
  CLOUD_NULL_LINK,
];

const FEED_CONSUMER_ID = "scss-feed-consumer";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let adminUserId = 0;
let studentAUserId = 0;
let studentBUserId = 0;
let inactiveStudentUserId = 0;
let noProfileStudentUserId = 0;

let studentAProfileId = 0;
let studentBProfileId = 0;

let authenticatorA: TestAuthenticator;
let authenticatorB: TestAuthenticator;

let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let department1Id = 0;
let level100Id = 0;
let academicSessionId = 0;
let firstSemesterId = 0;

let course1Id = 0;
let course2Id = 0;
let course3Id = 0;
let courseInactiveId = 0;

let offering1Id = 0;
let offering2Id = 0;
let offering3Id = 0;
let offeringClosedId = 0;
let offeringInactiveCourseId = 0;

let offering1SyncId = "";
let offering2SyncId = "";
let offeringClosedSyncId = "";

// A LOCAL session on offering1 so the eligibility response provably mixes both
// sources in one list.
let localSessionId = 0;

// The canonical session on the "cloud" side that the uploader resolves marks to.
// It is ENDED and out of its window so it never leaks into the edge's eligibility
// (the projection row is the only thing a student should ever see).
let canonicalCloudSessionId = 0;

const CANONICAL_SESSION_IDS = () => [canonicalCloudSessionId, localSessionId];

function cookieFrom(res: globalThis.Response): string | null {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${authConfig.cookieName}=`));
  if (!cookie) {
    return null;
  }
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";");
  return cookie.slice(eq + 1, semi);
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${authConfig.cookieName}=${token}` };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { headers });
}

async function loginStudent(matricNumber: string): Promise<string> {
  const res = await postJson("/api/auth/student/login", {
    matricNumber,
    password: TEST_PASSWORD,
  }, await boundDeviceHeaders(matricNumber));
  assert.equal(res.status, 200);
  const token = cookieFrom(res);
  assert.ok(token);
  return token!;
}

async function getEligible(token: string): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/student/attendance/eligible", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

async function mark(token: string, body: unknown): Promise<globalThis.Response> {
  return postJson("/api/student/attendance", body, cookieHeader(token));
}

async function deviceChallenge(token: string): Promise<string> {
  const res = await postJson(
    "/api/student/attendance/device-challenge",
    {},
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { challenge: string } };
  return body.data.challenge;
}

async function buildAssertion(
  authenticator: TestAuthenticator,
  challenge: string
) {
  return buildAuthenticationResponse({
    authenticator,
    challenge,
    origin: webauthnConfig.expectedOrigin,
    rpId: webauthnConfig.rpID,
    signCount: nextSignCount(authenticator),
  });
}

const nextSignCounts = new WeakMap<TestAuthenticator, number>();

function nextSignCount(authenticator: TestAuthenticator): number {
  const stored = nextSignCounts.get(authenticator) ?? 2;
  nextSignCounts.set(authenticator, stored + 1);
  return stored;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedDevice(
  studentProfileId: number,
  authenticator: TestAuthenticator
): Promise<void> {
  await pool.query(
    `INSERT INTO student_devices (student_id, credential_id, credential_public_key, counter, status, discoverable)
     VALUES ($1, $2, $3, 1, 'ACTIVE', TRUE)`,
    [
      studentProfileId,
      isoBase64URL.fromBuffer(authenticator.credentialId),
      Buffer.from(authenticator.credentialPublicKey),
    ]
  );
}

/**
 * A cloud-created attendance session as the edge would hold it after the feed has
 * been applied: a row in the `sync_attendance_sessions` projection.
 *
 * `offeringSyncId` is the master-data `course_offerings.sync_id` (NULL means the
 * edge has never resolved a local offering for this session, so it must stay
 * invisible to students).
 */
async function seedCloudSession(opts: {
  cloudSyncId: string;
  cloudSessionId: number;
  cloudCourseOfferingId: number;
  offeringSyncId: string | null;
  courseCode: string;
  courseTitle: string;
  startOffsetMin: number;
  endOffsetMin: number;
  lateThresholdMinutes: number;
  status: "ACTIVE" | "ENDED";
}): Promise<void> {
  await pool.query(
    `INSERT INTO sync_attendance_sessions
       (cloud_sync_id, cloud_session_id, cloud_course_offering_id,
        cloud_course_offering_sync_id, cloud_lecturer_id,
        course_code, course_title, lecturer_display_name, lecturer_staff_id,
        start_time, end_time, late_threshold_minutes, status, ended_at, source_event_cursor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             now() + ($10 * interval '1 minute'), now() + ($11 * interval '1 minute'),
             $12, $13,
             CASE WHEN $13 = 'ENDED' THEN now() - interval '30 minutes' END,
             $14)`,
    [
      opts.cloudSyncId,
      opts.cloudSessionId,
      opts.cloudCourseOfferingId,
      opts.offeringSyncId,
      3,
      opts.courseCode,
      opts.courseTitle,
      "Scss Cloud Lecturer",
      "SCSS/CLOUD/LEC",
      opts.startOffsetMin,
      opts.endOffsetMin,
      opts.lateThresholdMinutes,
      opts.status,
      9000000 + opts.cloudSessionId,
    ]
  );
}

async function insertSession(
  offeringId: number,
  lecturerProfileId: number,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
  status: "ACTIVE" | "ENDED",
  lateThresholdMinutes: number
): Promise<number> {
  const inserted = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, start_time, end_time, late_threshold, status, ended_at)
     VALUES ($1, $2, now() + ($3 * interval '1 minute'),
       now() + ($4 * interval '1 minute'),
       ($5 * interval '1 minute'), $6,
       CASE WHEN $6 = 'ENDED' THEN now() + ($4 * interval '1 minute') END)
     RETURNING id`,
    [
      offeringId,
      lecturerProfileId,
      startOffsetMinutes,
      endOffsetMinutes,
      lateThresholdMinutes,
      status,
    ]
  );
  return Number(inserted.rows[0].id);
}

/** Seed a change-feed event and return it as the apply service would see it. */
async function seedFeedEvent(options: {
  syncId: string;
  operation: SyncOperation;
  offeringSyncId: string | null;
}): Promise<SyncChangeEvent> {
  const payload = {
    version: SYNC_ATTENDANCE_SESSION_VERSION,
    syncId: options.syncId,
    cloudSessionId: 300000 + Math.floor(Math.random() * 1000),
    cloudCourseOfferingId: 7,
    cloudCourseOfferingSyncId: options.offeringSyncId,
    cloudLecturerId: 3,
    courseCode: "SCSS-102",
    courseTitle: "Scss Course Two",
    lecturerDisplayName: "Scss Cloud Lecturer",
    lecturerStaffId: "SCSS/CLOUD/LEC",
    startTime: new Date(Date.now() - 3_600_000).toISOString(),
    endTime: new Date(Date.now() - 3_000_000).toISOString(),
    lateThresholdMinutes: 5,
    status: options.operation === "CLOSED" ? "ENDED" : "ACTIVE",
    endedAt:
      options.operation === "CLOSED" ? new Date().toISOString() : null,
  };

  const inserted = await pool.query(
    `INSERT INTO sync_change_events
       (event_id, entity_type, entity_id, operation, payload)
     VALUES ($1, 'attendance_session', $2, $3, $4::jsonb)
     RETURNING cursor, event_id, recorded_at`,
    [randomUUID(), options.syncId, options.operation, JSON.stringify({ version: SYNC_ATTENDANCE_SESSION_VERSION, entity: payload })]
  );

  const row = inserted.rows[0];
  return {
    eventId: row.event_id,
    cursor: Number(row.cursor),
    entityType: "attendance_session",
    entityId: options.syncId,
    operation: options.operation,
    payload,
    recordedAt: row.recorded_at.toISOString(),
  };
}

async function setFeedCursorBefore(event: SyncChangeEvent): Promise<void> {
  await pool.query(
    `INSERT INTO sync_consumer_state (consumer_id, last_cursor)
     VALUES ($1, $2)
     ON CONFLICT (consumer_id) DO UPDATE SET last_cursor = EXCLUDED.last_cursor`,
    [FEED_CONSUMER_ID, event.cursor - 1]
  );
}

async function markCloudSession(
  token: string,
  sessionSyncId: string,
  authenticator: TestAuthenticator
): Promise<globalThis.Response> {
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticator, challenge);
  return mark(token, { attendanceSessionSyncId: sessionSyncId, assertion });
}

async function countCloudQueueRows(sessionSyncId: string, studentProfileId: number): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM sync_outbound_attendance_marks
     WHERE session_sync_id = $1 AND student_id = $2`,
    [sessionSyncId, studentProfileId]
  );
  return result.rows[0].n;
}

function assertErrorCode(body: unknown, code: string): void {
  assert.ok(body && typeof body === "object");
  assert.equal((body as { error: string }).error, code);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Wipe mark state between tests so each test starts against an unmarked cloud session. */
async function resetMarkState(): Promise<void> {
  await pool.query(
    `DELETE FROM sync_inbound_attendance_receipts
     WHERE queue_id IN (
       SELECT queue_id FROM sync_outbound_attendance_marks
       WHERE session_sync_id = ANY($1::UUID[])
     )`,
    [ALL_CLOUD_SYNC_IDS()]
  );
  await pool.query(
    `DELETE FROM sync_outbound_attendance_marks
     WHERE session_sync_id = ANY($1::UUID[])`,
    [ALL_CLOUD_SYNC_IDS()]
  );
  await pool.query(
    `DELETE FROM sync_outbound_attendance_marks
     WHERE attendance_record_id IN (
       SELECT id FROM attendance_records WHERE session_id = ANY($1::BIGINT[])
     )`,
    [CANONICAL_SESSION_IDS()]
  );
  await pool.query(
    `DELETE FROM attendance_records WHERE session_id = ANY($1::BIGINT[])`,
    [CANONICAL_SESSION_IDS()]
  );
}

async function cleanupScopedData(): Promise<void> {
  await resetMarkState();

  await pool.query(`DELETE FROM sync_attendance_sessions`);

  // The feed-applier proof seeds one change event and its consumer state.
  await pool.query(`DELETE FROM sync_processed_events WHERE consumer_id = $1`, [
    FEED_CONSUMER_ID,
  ]);
  await pool.query(`DELETE FROM sync_consumer_state WHERE consumer_id = $1`, [
    FEED_CONSUMER_ID,
  ]);
  await pool.query(
    `DELETE FROM sync_change_events e
     WHERE NOT EXISTS (
       SELECT 1 FROM sync_attendance_sessions s WHERE s.cloud_sync_id::text = e.entity_id
     )`
  );

  await pool.query(
    `DELETE FROM attendance_sessions
     WHERE course_offering_id IN (
       SELECT co.id FROM course_offerings co
       JOIN courses c ON c.id = co.course_id
       WHERE c.course_code LIKE 'SCSS%'
     )`
  );
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT co.id FROM course_offerings co
       JOIN courses c ON c.id = co.course_id
       WHERE c.course_code LIKE 'SCSS%'
     )`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT co.id FROM course_offerings co
       JOIN courses c ON c.id = co.course_id
       WHERE c.course_code LIKE 'SCSS%'
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'SCSS%')`
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'SCSS%'`);
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'SCSS%'`);

  await pool.query(
    `DELETE FROM student_device_enrollment_challenges
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'SCSS/%'
     )`
  );
  await pool.query(
    `DELETE FROM student_devices
     WHERE student_id IN (
       SELECT id FROM students WHERE matric_number LIKE 'SCSS/%'
     )`
  );
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'SCSS/%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'SCSS/%'`);
  await pool.query(
    `DELETE FROM sessions WHERE user_id IN (
       SELECT id FROM users
       WHERE username = $1 OR name LIKE 'Scss %' OR name LIKE 'SCSS %'
     )`,
    [ADMIN_USERNAME]
  );
  await pool.query(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'Scss %' OR name LIKE 'SCSS %'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'SCSS%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'SCSS%'`);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  const admin = await pool.query(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('Scss Admin', $1, 'ADMIN', 'ACTIVE', $2)
     RETURNING id`,
    [passwordHash, ADMIN_USERNAME]
  );
  adminUserId = Number(admin.rows[0].id);

  const fac = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Scss Faculty', 'SCSS-FAC') RETURNING id`
  );
  const facId = Number(fac.rows[0].id);

  const dep = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Scss Department', 'SCSS-DEP', $1) RETURNING id`,
    [facId]
  );
  department1Id = Number(dep.rows[0].id);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const acad = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('SCSS-2026', true) RETURNING id`
  );
  academicSessionId = Number(acad.rows[0].id);

  const sem = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  firstSemesterId = Number(sem.rows[0].id);
  const sem2 = await pool.query(
    `SELECT id FROM semesters WHERE name = 'Second Semester'`
  );
  const secondSemesterId = Number(sem2.rows[0].id);

  async function insertCourse(
    code: string,
    title: string,
    status = "ACTIVE"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO courses (course_code, title, faculty_id, level_id, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [code, title, facId, level100Id, status]
    );
    return Number(res.rows[0].id);
  }

  course1Id = await insertCourse("SCSS-101", "Scss Course One");
  course2Id = await insertCourse("SCSS-102", "Scss Course Two");
  course3Id = await insertCourse("SCSS-103", "Scss Course Three");
  courseInactiveId = await insertCourse("SCSS-104", "Scss Course Inactive", "INACTIVE");

  async function insertOffering(
    courseId: number,
    semesterId: number,
    status = "OPEN"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [courseId, academicSessionId, semesterId, status]
    );
    return Number(res.rows[0].id);
  }

  offering1Id = await insertOffering(course1Id, firstSemesterId);
  offering2Id = await insertOffering(course2Id, firstSemesterId);
  offering3Id = await insertOffering(course3Id, firstSemesterId);
  offeringClosedId = await insertOffering(course1Id, secondSemesterId, "CLOSED");
  offeringInactiveCourseId = await insertOffering(courseInactiveId, firstSemesterId);

  const syncIdOf = async (table: string, id: number): Promise<string> => {
    const row = await pool.query(`SELECT sync_id FROM ${table} WHERE id = $1`, [id]);
    return row.rows[0].sync_id as string;
  };
  offering1SyncId = await syncIdOf("course_offerings", offering1Id);
  offering2SyncId = await syncIdOf("course_offerings", offering2Id);
  offeringClosedSyncId = await syncIdOf("course_offerings", offeringClosedId);
  const inactiveOfferingSyncId = await syncIdOf("course_offerings", offeringInactiveCourseId);
  const offering3SyncId = await syncIdOf("course_offerings", offering3Id);

  async function insertUser(
    name: string,
    role: string,
    status: string,
    username: string | null
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, passwordHash, role, status, username]
    );
    return Number(res.rows[0].id);
  }

  async function insertStudent(userId: number, matric: string): Promise<number> {
    const res = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, matric, department1Id, level100Id]
    );
    return Number(res.rows[0].id);
  }

  async function insertLecturer(userId: number, staffId: string): Promise<number> {
    const res = await pool.query(
      `INSERT INTO lecturers (user_id, staff_id, department_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, staffId, department1Id]
    );
    return Number(res.rows[0].id);
  }

  studentAUserId = await insertUser("Scss Student A", "STUDENT", "ACTIVE", null);
  studentBUserId = await insertUser("Scss Student B", "STUDENT", "ACTIVE", null);
  inactiveStudentUserId = await insertUser("Scss Student Inactive", "STUDENT", "INACTIVE", null);
  noProfileStudentUserId = await insertUser("Scss Student No Profile", "STUDENT", "ACTIVE", null);
  const lecturer1UserId = await insertUser("Scss Lecturer One", "LECTURER", "ACTIVE", null);
  const lecturer2UserId = await insertUser("Scss Lecturer Two", "LECTURER", "ACTIVE", null);

  studentAProfileId = await insertStudent(studentAUserId, STUDENT_A_MATRIC);
  studentBProfileId = await insertStudent(studentBUserId, STUDENT_B_MATRIC);
  await insertStudent(inactiveStudentUserId, "SCSS/STU/INACTIVE");

  authenticatorA = await createTestAuthenticator();
  authenticatorB = await createTestAuthenticator();
  await seedDevice(studentAProfileId, authenticatorA);
  await seedDevice(studentBProfileId, authenticatorB);

  lecturer1ProfileId = await insertLecturer(lecturer1UserId, "SCSS/LEC/1");
  lecturer2ProfileId = await insertLecturer(lecturer2UserId, "SCSS/LEC/2");

  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED'), ($1, $3, 'ENROLLED'),
            ($1, $4, 'ENROLLED'), ($5, $3, 'ENROLLED')`,
    [studentAProfileId, offering1Id, offering2Id, offeringClosedId, studentBProfileId]
  );

  // A LOCAL session so one eligible list genuinely mixes both sources.
  localSessionId = await insertSession(offering1Id, lecturer1ProfileId, -15, 45, "ACTIVE", 5);

  // The cloud's OWN canonical copy of CLOUD_ACTIVE_1 (same sync id). ENDED and
  // out of window so it never surfaces through the edge's local eligibility; it
  // only exists so the uploader proof has something to resolve marks against.
  const canonical = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, start_time, end_time, late_threshold, status, ended_at, sync_id)
     VALUES ($1, $2, now() - interval '90 minutes', now() - interval '30 minutes',
             interval '5 minutes', 'ENDED', now() - interval '30 minutes', $3)
     RETURNING id`,
    [offering1Id, lecturer1ProfileId, CLOUD_ACTIVE_1]
  );
  canonicalCloudSessionId = Number(canonical.rows[0].id);

  // Cloud projection sessions.
  await seedCloudSession({
    cloudSyncId: CLOUD_ACTIVE_1,
    cloudSessionId: 200001,
    cloudCourseOfferingId: 90001,
    offeringSyncId: offering1SyncId,
    courseCode: "SCSS-101",
    courseTitle: "Scss Course One",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 10,
    status: "ACTIVE",
  });
  await seedCloudSession({
    cloudSyncId: CLOUD_ACTIVE_2,
    cloudSessionId: 200002,
    cloudCourseOfferingId: 90002,
    offeringSyncId: offering2SyncId,
    courseCode: "SCSS-102",
    courseTitle: "Scss Course Two",
    startOffsetMin: -10,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  // Excluded because the local offering is CLOSED / course is INACTIVE.
  await seedCloudSession({
    cloudSyncId: CLOUD_CLOSED_OFFERING,
    cloudSessionId: 200003,
    cloudCourseOfferingId: 90003,
    offeringSyncId: offeringClosedSyncId,
    courseCode: "SCSS-101",
    courseTitle: "Scss Course One",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  await seedCloudSession({
    cloudSyncId: CLOUD_INACTIVE_COURSE,
    cloudSessionId: 200004,
    cloudCourseOfferingId: 90004,
    offeringSyncId: inactiveOfferingSyncId,
    courseCode: "SCSS-104",
    courseTitle: "Scss Course Inactive",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  // Excluded because the session itself is ended / already expired.
  await seedCloudSession({
    cloudSyncId: CLOUD_ENDED,
    cloudSessionId: 200005,
    cloudCourseOfferingId: 90005,
    offeringSyncId: offering2SyncId,
    courseCode: "SCSS-102",
    courseTitle: "Scss Course Two",
    startOffsetMin: -60,
    endOffsetMin: -30,
    lateThresholdMinutes: 5,
    status: "ENDED",
  });
  await seedCloudSession({
    cloudSyncId: CLOUD_EXPIRED,
    cloudSessionId: 200006,
    cloudCourseOfferingId: 90006,
    offeringSyncId: offering2SyncId,
    courseCode: "SCSS-102",
    courseTitle: "Scss Course Two",
    startOffsetMin: -60,
    endOffsetMin: -30,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  // Excluded because student A is not registered for offering3.
  await seedCloudSession({
    cloudSyncId: CLOUD_UNREGISTERED,
    cloudSessionId: 200007,
    cloudCourseOfferingId: 90007,
    offeringSyncId: offering3SyncId,
    courseCode: "SCSS-103",
    courseTitle: "Scss Course Three",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  // Excluded because the edge has never resolved a matching local offering.
  await seedCloudSession({
    cloudSyncId: CLOUD_UNKNOWN_LINK,
    cloudSessionId: 200008,
    cloudCourseOfferingId: 90008,
    offeringSyncId: randomUUID(),
    courseCode: "SCSS-101",
    courseTitle: "Scss Course One",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });
  await seedCloudSession({
    cloudSyncId: CLOUD_NULL_LINK,
    cloudSessionId: 200009,
    cloudCourseOfferingId: 90009,
    offeringSyncId: null,
    courseCode: "SCSS-101",
    courseTitle: "Scss Course One",
    startOffsetMin: -5,
    endOffsetMin: 60,
    lateThresholdMinutes: 5,
    status: "ACTIVE",
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(resetMarkState);

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  await cleanupScopedData();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Feed wiring: the applier stores the offering sync id that marking depends on
// ---------------------------------------------------------------------------

test("SCSS feed: the applier stores cloudCourseOfferingSyncId so a cloud session becomes markable", async () => {
  const syncId = randomUUID();
  const event = await seedFeedEvent({ syncId, operation: "CREATED", offeringSyncId: offering2SyncId });
  await setFeedCursorBefore(event);

  const result = await applyChangeBatch(FEED_CONSUMER_ID, [event]);
  assert.equal(result.applied, 1);

  const row = await pool.query(
    `SELECT cloud_course_offering_sync_id, status FROM sync_attendance_sessions
     WHERE cloud_sync_id = $1`,
    [syncId]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].cloud_course_offering_sync_id, offering2SyncId);
  assert.equal(row.rows[0].status, "ACTIVE");
});

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test("SCSS auth: an unauthenticated eligible request is rejected", async () => {
  const res = await get("/api/student/attendance/eligible");
  assert.equal(res.status, 401);
  assertErrorCode(await res.json(), "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("SCSS eligibility: a cloud session appears with source CLOUD and its sync id", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);

  const cloud1 = sessions.find((s) => s.sessionSyncId === CLOUD_ACTIVE_1);
  const cloud2 = sessions.find((s) => s.sessionSyncId === CLOUD_ACTIVE_2);
  const local = sessions.find((s) => Number(s.id) === localSessionId);

  assert.ok(cloud1, "student A should see CLOUD_ACTIVE_1");
  assert.equal(cloud1!.source, "CLOUD");
  // The id on a cloud session is the informational cloud_session_id, not a local id.
  assert.equal(cloud1!.id, 200001);
  assert.equal(cloud1!.attendanceSessionId, undefined);
  assert.equal(cloud1!.courseCode, "SCSS-101");
  assert.equal(cloud1!.courseTitle, "Scss Course One");
  assert.equal(cloud1!.currentAttendanceState, "NOT_MARKED");

  assert.ok(cloud2, "student A should see CLOUD_ACTIVE_2");
  assert.equal(cloud2!.source, "CLOUD");
  assert.equal(cloud2!.sessionSyncId, CLOUD_ACTIVE_2);

  assert.ok(local, "the LOCAL session must still be listed");
  assert.equal(local!.source, "LOCAL");
  assert.equal(typeof local!.sessionSyncId, "string");
});

test("SCSS eligibility: an unregistered student does not see that cloud session", async () => {
  const token = await loginStudent(STUDENT_B_MATRIC);
  const sessions = await getEligible(token);

  const syncIds = sessions.map((s) => s.sessionSyncId);
  assert.ok(!syncIds.includes(CLOUD_ACTIVE_1), "student B is not enrolled in offering1");
  assert.ok(syncIds.includes(CLOUD_ACTIVE_2), "student B is enrolled in offering2");
});

test("SCSS eligibility: closed offering, inactive course, ended and expired sessions never appear", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const sessions = await getEligible(token);
  const syncIds = sessions.map((s) => s.sessionSyncId);

  assert.ok(!syncIds.includes(CLOUD_CLOSED_OFFERING), "closed offering must not appear");
  assert.ok(!syncIds.includes(CLOUD_INACTIVE_COURSE), "inactive course must not appear");
  assert.ok(!syncIds.includes(CLOUD_ENDED), "ended session must not appear");
  assert.ok(!syncIds.includes(CLOUD_EXPIRED), "expired session must not appear");
  assert.ok(!syncIds.includes(CLOUD_UNREGISTERED), "unregistered session must not appear");
  assert.ok(!syncIds.includes(CLOUD_UNKNOWN_LINK), "unresolvable offering must not appear");
  assert.ok(!syncIds.includes(CLOUD_NULL_LINK), "a NULL offering link must not appear");
});

test("SCSS eligibility: a marked cloud session reports its queue state as the attendance state", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_ACTIVE_2, authenticatorA);
  assert.equal(res.status, 201);

  const sessions = await getEligible(token);
  const cloud2 = sessions.find((s) => s.sessionSyncId === CLOUD_ACTIVE_2);
  assert.ok(cloud2);
  assert.equal(cloud2!.currentAttendanceState, "LATE");
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("SCSS validation: a request must name exactly one session reference", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorA, challenge);

  const invalidBodies = [
    {},
    { attendanceSessionSyncId: CLOUD_ACTIVE_1, attendanceSessionId: 123, assertion },
    { attendanceSessionSyncId: "not-a-uuid", assertion },
    { attendanceSessionSyncId: 42, assertion },
    { attendanceSessionSyncId: CLOUD_ACTIVE_1 },
  ];

  for (const body of invalidBodies) {
    const res = await mark(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assertErrorCode(await res.json(), "INVALID_REQUEST");
  }
});

// ---------------------------------------------------------------------------
// Authoritative checks
// ---------------------------------------------------------------------------

test("SCSS checks: an unknown cloud session sync id is 404", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, randomUUID(), authenticatorA);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("SCSS checks: an unresolvable offering link is 404 (never silently unlinked)", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_UNKNOWN_LINK, authenticatorA);
  assert.equal(res.status, 404);
  assertErrorCode(await res.json(), "SESSION_NOT_FOUND");
});

test("SCSS checks: an ended cloud session is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_ENDED, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_NOT_ACTIVE");
});

test("SCSS checks: an expired cloud session is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_EXPIRED, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "SESSION_NOT_ACTIVE");
});

test("SCSS checks: a closed offering is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_CLOSED_OFFERING, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "OFFERING_NOT_OPEN");
});

test("SCSS checks: an inactive course is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_INACTIVE_COURSE, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "COURSE_NOT_ACTIVE");
});

test("SCSS checks: an unregistered student is rejected", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_UNREGISTERED, authenticatorA);
  assert.equal(res.status, 409);
  assertErrorCode(await res.json(), "STUDENT_NOT_REGISTERED");
});

// ---------------------------------------------------------------------------
// Successful marking
// ---------------------------------------------------------------------------

test("SCSS success: within the late threshold is PRESENT and queues exactly one NULL-record row", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA);

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.source, "CLOUD");
  assert.equal(body.data.sessionSyncId, CLOUD_ACTIVE_1);
  assert.equal(body.data.attendanceSessionId, 200001);
  assert.equal(body.data.status, "PRESENT");
  assert.equal(body.data.courseCode, "SCSS-101");
  assert.equal(body.data.courseTitle, "Scss Course One");
  assert.equal(typeof body.data.markedAt, "string");
  assert.ok(Number.isNaN(Date.parse(body.data.markedAt as string)) === false);

  // Exactly one durable upload is queued, and it has no local record reference:
  // a cloud session owns no canonical attendance record on the edge.
  const rows = await pool.query(
    `SELECT attendance_record_id, mark_status, session_sync_id, student_id
     FROM sync_outbound_attendance_marks
     WHERE session_sync_id = $1 AND student_id = $2`,
    [CLOUD_ACTIVE_1, studentAProfileId]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].attendance_record_id, null);
  assert.equal(rows.rows[0].mark_status, "PRESENT");
  assert.equal(rows.rows[0].session_sync_id, CLOUD_ACTIVE_1);
  assert.equal(Number(rows.rows[0].student_id), studentAProfileId);

  // No CANONICAL record is created locally for the projection session.
  const records = await pool.query(
    `SELECT count(*)::int AS n FROM attendance_records WHERE student_id = $1
     AND session_id IN (SELECT id FROM attendance_sessions WHERE sync_id = $2)`,
    [studentAProfileId, CLOUD_ACTIVE_1]
  );
  assert.equal(records.rows[0].n, 0);
});

test("SCSS success: after the late threshold is LATE", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const res = await markCloudSession(token, CLOUD_ACTIVE_2, authenticatorA);

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "LATE");
  assert.equal(body.data.sessionSyncId, CLOUD_ACTIVE_2);
  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_2, studentAProfileId), 1);
});

test("SCSS success: client-supplied identity, status, and timestamps are ignored", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorA, challenge);
  const res = await mark(token, {
    attendanceSessionSyncId: CLOUD_ACTIVE_2,
    assertion,
    studentId: 999999,
    userId: 999999,
    courseOfferingId: 999999,
    cloudCourseOfferingId: 999999,
    cloudCourseOfferingSyncId: randomUUID(),
    status: "PRESENT",
    markedAt: "2020-01-01T00:00:00.000Z",
    lecturerId: 999999,
  });

  assert.equal(res.status, 201);
  const body = (await res.json()) as { data: Record<string, unknown> };
  assert.equal(body.data.status, "LATE", "status must be derived server-side");
  assert.equal(body.data.studentId, studentAProfileId);
  assert.equal(body.data.sessionSyncId, CLOUD_ACTIVE_2);

  const row = await pool.query(
    `SELECT mark_status, student_id, session_sync_id FROM sync_outbound_attendance_marks
     WHERE session_sync_id = $1 AND student_id = $2`,
    [CLOUD_ACTIVE_2, studentAProfileId]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].mark_status, "LATE");
  assert.equal(Number(row.rows[0].student_id), studentAProfileId);
  assert.equal(row.rows[0].session_sync_id, CLOUD_ACTIVE_2);
});

// ---------------------------------------------------------------------------
// Device gate
// ---------------------------------------------------------------------------

test("SCSS device gate: a mismatched authenticator never reaches the marking logic", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const challenge = await deviceChallenge(token);
  const assertion = await buildAssertion(authenticatorB, challenge);

  const res = await mark(token, { attendanceSessionSyncId: CLOUD_ACTIVE_1, assertion });
  assert.equal(res.status, 400);
  assertErrorCode(await res.json(), "INVALID_DEVICE_ASSERTION");
  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_1, studentAProfileId), 0);
});

// ---------------------------------------------------------------------------
// Duplicates and concurrency
// ---------------------------------------------------------------------------

test("SCSS duplicates: a second marking of the same cloud session is 409", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const first = await markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA);
  assert.equal(first.status, 201);

  const second = await markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA);
  assert.equal(second.status, 409);
  assertErrorCode(await second.json(), "ALREADY_MARKED");
  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_1, studentAProfileId), 1);
});

test("SCSS concurrency: simultaneous attempts create exactly one queue row", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);

  const [res1, res2] = await Promise.all([
    markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA),
    markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA),
  ]);

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], "one request wins, the other reports already marked");

  const conflict = res1.status === 409 ? res1 : res2;
  assertErrorCode(await conflict.json(), "ALREADY_MARKED");
  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_1, studentAProfileId), 1);
});

// ---------------------------------------------------------------------------
// Isolation between students
// ---------------------------------------------------------------------------

test("SCSS isolation: one student's cloud mark never affects or exposes another's", async () => {
  const tokenA = await loginStudent(STUDENT_A_MATRIC);
  const tokenB = await loginStudent(STUDENT_B_MATRIC);

  const aRes = await markCloudSession(tokenA, CLOUD_ACTIVE_2, authenticatorA);
  assert.equal(aRes.status, 201);

  const bRes = await markCloudSession(tokenB, CLOUD_ACTIVE_2, authenticatorB);
  assert.equal(bRes.status, 201);
  const bBody = (await bRes.json()) as { data: Record<string, unknown> };
  assert.equal(bBody.data.status, "LATE");

  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_2, studentAProfileId), 1);
  assert.equal(await countCloudQueueRows(CLOUD_ACTIVE_2, studentBProfileId), 1);

  const bOnA = await markCloudSession(tokenB, CLOUD_ACTIVE_1, authenticatorB);
  assert.equal(bOnA.status, 409);
  assertErrorCode(await bOnA.json(), "STUDENT_NOT_REGISTERED");
});

// ---------------------------------------------------------------------------
// Uploader end-to-end: mark -> queue -> upload -> cloud canonical record -> SENT
// ---------------------------------------------------------------------------

test("SCSS upload: a marked cloud session uploads to the cloud and lands as a canonical record", async () => {
  const token = await loginStudent(STUDENT_A_MATRIC);
  const marked = await markCloudSession(token, CLOUD_ACTIVE_1, authenticatorA);
  assert.equal(marked.status, 201);
  const markedBody = (await marked.json()) as { data: Record<string, unknown> };

  const consumerConfig: SyncConsumerConfig = {
    enabled: true,
    consumerId: "scss-test-edge",
    cloudBaseUrl: baseUrl,
    edgeSecret: TEST_EDGE_SECRET,
    intervalMs: 0,
    batchLimit: 10,
    requestTimeoutMs: 10_000,
  };

  const summary = await uploadPendingAttendanceMarks(consumerConfig);
  assert.deepEqual(summary, { attempted: 1, accepted: 1, rejected: 0, deferred: 0 });

  // The cloud recorded a canonical attendance_record for the canonical session
  // (the ENDED cloud copy whose sync id matches), for this student, with the
  // server-derived status and timestamp.
  const record = await pool.query(
    `SELECT ar.id, ar.status, ar.marked_at, ar.student_id
     FROM attendance_records ar
     JOIN attendance_sessions s ON s.id = ar.session_id
     WHERE s.sync_id = $1 AND ar.student_id = $2`,
    [CLOUD_ACTIVE_1, studentAProfileId]
  );
  assert.equal(record.rows.length, 1);
  assert.equal(record.rows[0].status, "PRESENT");

  // The edge queue row moved to SENT with the cloud's record id, and its record
  // reference stays NULL (it never had a local record).
  const queue = await pool.query(
    `SELECT queue_id, status, cloud_record_id, attendance_record_id
     FROM sync_outbound_attendance_marks
     WHERE session_sync_id = $1 AND student_id = $2`,
    [CLOUD_ACTIVE_1, studentAProfileId]
  );
  assert.equal(queue.rows.length, 1);
  assert.equal(queue.rows[0].status, "SENT");
  assert.equal(Number(queue.rows[0].cloud_record_id), Number(record.rows[0].id));
  assert.equal(queue.rows[0].attendance_record_id, null);

  // A receipt pins the mapping so a retried delivery returns the same record id.
  const receipt = await pool.query(
    `SELECT cloud_record_id FROM sync_inbound_attendance_receipts WHERE queue_id = $1`,
    [queue.rows[0].queue_id]
  );
  assert.equal(receipt.rows.length, 1);
  assert.equal(Number(receipt.rows[0].cloud_record_id), Number(record.rows[0].id));

  // The uploader did not touch the marking response's timestamp: it is the
  // same timestamp the cloud stored (within a small tolerance for the DB clock).
  const markedAt = new Date(markedBody.data.markedAt as string).getTime();
  const storedAt = new Date(record.rows[0].marked_at).getTime();
  assert.ok(Math.abs(storedAt - markedAt) < 60_000);

  // Nothing is left pending: a second run is a no-op.
  const again = await uploadPendingAttendanceMarks(consumerConfig);
  assert.deepEqual(again, { attempted: 0, accepted: 0, rejected: 0, deferred: 0 });
});