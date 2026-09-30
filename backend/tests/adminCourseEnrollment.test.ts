import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

/**
 * Admin Course Enrollment integration tests.
 *
 * Exercises the real POST /api/admin/course-offerings/:id/registrations endpoint
 * and the GET roster endpoint. Every fixture lives under the ACE2 namespace so
 * this suite runs alongside the other integration tests without collisions.
 *
 * Cleanup is scoped to ACE2-prefixed rows only — canonical reference data
 * (100/200/300 levels, seed users, etc.) is never touched.
 */

const TEST_PASSWORD = "ace2-test-password";
const ADMIN_USERNAME = "ace2_admin";
const MATRIC_PREFIX = "ACE2";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl = "";

// Shared infrastructure
let adminUserId = 0;
let facultyId = 0;
let departmentId = 0;
let level100Id = 0;
let level200Id = 0;
let level300Id = 0;
let activeSessionId = 0;
let oldSessionId = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

// Courses
let courseActive100DeptId = 0;
let courseActive100FacId = 0;
let courseActive200DeptId = 0;
let courseActive300DeptId = 0;
let courseInactiveId = 0;

// Offerings (per test scenario)
let offeringOpen100DeptId = 0;
let offeringOpen100FacId = 0;
let offeringOpen200DeptId = 0;
let offeringOpen300DeptId = 0;
let offeringClosedId = 0;
let offeringOldSessionId = 0;
let offeringInactiveCourseId = 0;

// Students (per test scenario)
let studentActive100DeptId = 0;
let studentActive100FacId = 0;
let studentActive200DeptId = 0;
let studentActive300DeptId = 0;
let studentCompleted100DeptId = 0;
let studentInactiveId = 0;
let studentWrongLevelId = 0;
let studentWrongFacultyId = 0;
let studentWrongDeptId = 0;
let studentNonStudentId = 0;

// Pre-seeded registrations
let existingEnrolledRegId = 0;
let existingDroppedRegId = 0;
let existingCompletedRegId = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function p(query: string, params: unknown[] = []): Promise<unknown> {
  return pool.query(query, params);
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `oou_session=${token}` };
}

async function getAdminToken(): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: TEST_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie") ?? "";
  const match = cookie.match(/oou_session=([^;]+)/);
  assert.ok(match, "admin login should issue a session cookie");
  return match[1];
}

async function getStudentToken(matricNumber: string): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/student/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matricNumber, password: TEST_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie") ?? "";
  const match = cookie.match(/oou_session=([^;]+)/);
  assert.ok(match);
  return match[1];
}

async function getLecturerToken(staffId: string): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/lecturer/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staffId, password: TEST_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie") ?? "";
  const match = cookie.match(/oou_session=([^;]+)/);
  assert.ok(match);
  return match[1];
}

async function postJson(
  path: string,
  body: unknown,
  token: string
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookieHeader(token) },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, token: string): Promise<globalThis.Response> {
  return fetch(`${baseUrl}${path}`, { headers: cookieHeader(token) });
}

function errorCode(body: unknown): string {
  return (body as { error?: string }).error ?? "";
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  // Delete audit logs first (no FK dependencies)
  await p(
    `DELETE FROM audit_logs
     WHERE action = 'STUDENT_COURSE_ENROLLMENT'
       AND (user_id IN (SELECT id FROM users WHERE username = $1)
            OR description LIKE '%ACE2/%')`,
    [ADMIN_USERNAME]
  );

  // Delete registrations first (FK)
  await p(
    `DELETE FROM course_registrations WHERE course_offering_id IN (
      SELECT id FROM course_offerings
      WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ACE2-%')
         OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ACE2-%')
    )`
  );
  await p(
    `DELETE FROM course_offering_lecturers WHERE course_offering_id IN (
      SELECT id FROM course_offerings
      WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'ACE2-%')
         OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'ACE2-%')
    )`
  );
  await p(
    `DELETE FROM course_offerings WHERE course_id IN (
      SELECT id FROM courses WHERE course_code LIKE 'ACE2-%'
    ) OR academic_session_id IN (
      SELECT id FROM academic_sessions WHERE name LIKE 'ACE2-%'
    )`
  );
  await p(`DELETE FROM academic_sessions WHERE name LIKE 'ACE2-%'`);
  await p(`DELETE FROM courses WHERE course_code LIKE 'ACE2-%'`);
  await p(`DELETE FROM students WHERE matric_number LIKE 'ACE2/%'`);
  await p(`DELETE FROM lecturers WHERE staff_id LIKE 'ACE2/%'`);
  await p(`DELETE FROM sessions WHERE user_id IN (
    SELECT id FROM users WHERE name LIKE 'ACE2 %' OR username = $1
  )`, [ADMIN_USERNAME]);
  await p(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await p(`DELETE FROM users WHERE name LIKE 'ACE2 %'`);
  // Delete departments BEFORE faculties (departments -> faculty FK has RESTRICT)
  await p(`DELETE FROM departments WHERE code LIKE 'ACE2-DEP%'`);
  await p(`DELETE FROM departments WHERE code LIKE 'ACE2-DEP2'`);
  await p(`DELETE FROM departments WHERE code LIKE 'ACE2-DEP3'`);
  await p(`DELETE FROM faculties WHERE code LIKE 'ACE2-FAC%'`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(async () => {
  await cleanup();

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // --- Admin ---
  const adminUser = await p(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ($1, $2, 'ADMIN', 'ACTIVE', $3) RETURNING id`,
    [`ACE2 Admin`, await hashPassword(TEST_PASSWORD), ADMIN_USERNAME]
  );
  adminUserId = Number(adminUser.rows[0].id);

  // --- Faculty + Department ---
  const fac = await p(
    `INSERT INTO faculties (code, name) VALUES ('ACE2-FAC', 'ACE2 Faculty') RETURNING id`
  );
  facultyId = Number(fac.rows[0].id);
  const dept = await p(
    `INSERT INTO departments (code, name, faculty_id)
     VALUES ('ACE2-DEP', 'ACE2 Department', $1) RETURNING id`,
    [facultyId]
  );
  departmentId = Number(dept.rows[0].id);

  // --- Levels (use existing 100/200/300, do NOT create new ones) ---
  const l1 = await p(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(l1.rows[0].id);
  const l2 = await p(`SELECT id FROM levels WHERE name = 200`);
  level200Id = Number(l2.rows[0].id);
  const l3 = await p(`SELECT id FROM levels WHERE name = 300`);
  level300Id = Number(l3.rows[0].id);

  // --- Academic sessions ---
  const activeSess = await p(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ACE2-ACTIVE', true) RETURNING id`
  );
  activeSessionId = Number(activeSess.rows[0].id);
  const oldSess = await p(
    `INSERT INTO academic_sessions (name, is_active) VALUES ('ACE2-OLD', false) RETURNING id`
  );
  oldSessionId = Number(oldSess.rows[0].id);

  // --- Semesters ---
  const semRes = await p(`SELECT id, name FROM semesters`);
  const semMap = new Map<string, number>();
  for (const r of semRes.rows) {
    semMap.set((r as { name: string }).name, Number((r as { id: number }).id));
  }
  firstSemesterId = semMap.get("First Semester")!;
  secondSemesterId = semMap.get("Second Semester")!;

  // --- Courses ---
  async function insertCourse(
    code: string,
    title: string,
    levelId: number,
    departmentId: number | null,
    facultyId: number | null,
    status = "ACTIVE"
  ): Promise<number> {
    const res = await p(
      `INSERT INTO courses (course_code, title, level_id, department_id, faculty_id, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [code, title, levelId, departmentId, facultyId, status]
    );
    return Number(res.rows[0].id);
  }

  courseActive100DeptId = await insertCourse(
    `ACE2-C-100-DEPT`, "ACE2 Course 100 Dept", level100Id, departmentId, null
  );
  courseActive100FacId = await insertCourse(
    `ACE2-C-100-FAC`, "ACE2 Course 100 Fac", level100Id, null, facultyId
  );
  courseActive200DeptId = await insertCourse(
    `ACE2-C-200-DEPT`, "ACE2 Course 200 Dept", level200Id, departmentId, null
  );
  courseActive300DeptId = await insertCourse(
    `ACE2-C-300-DEPT`, "ACE2 Course 300 Dept", level300Id, departmentId, null
  );
  courseInactiveId = await insertCourse(
    `ACE2-C-INACTIVE`, "ACE2 Inactive Course", level100Id, departmentId, null, "INACTIVE"
  );

  // --- Offerings ---
  async function insertOffering(
    courseId: number,
    sessionId: number,
    semesterId: number,
    status = "OPEN"
  ): Promise<number> {
    const res = await p(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [courseId, sessionId, semesterId, status]
    );
    return Number(res.rows[0].id);
  }

  offeringOpen100DeptId = await insertOffering(
    courseActive100DeptId, activeSessionId, firstSemesterId
  );
  offeringOpen100FacId = await insertOffering(
    courseActive100FacId, activeSessionId, firstSemesterId
  );
  offeringOpen200DeptId = await insertOffering(
    courseActive200DeptId, activeSessionId, firstSemesterId
  );
  offeringOpen300DeptId = await insertOffering(
    courseActive300DeptId, activeSessionId, firstSemesterId
  );
  offeringClosedId = await insertOffering(
    courseActive100DeptId, activeSessionId, secondSemesterId, "CLOSED"
  );
  offeringOldSessionId = await insertOffering(
    courseActive100DeptId, oldSessionId, firstSemesterId
  );
  offeringInactiveCourseId = await insertOffering(
    courseInactiveId, activeSessionId, firstSemesterId
  );

  // --- Student helper ---
  async function makeStudent(
    name: string,
    matric: string,
    levelId: number,
    departmentId: number,
    status = "ACTIVE",
    role = "STUDENT"
  ): Promise<{ userId: number; profileId: number }> {
    const user = await p(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [name, await hashPassword(TEST_PASSWORD), role, status]
    );
    const userId = Number(user.rows[0].id);
    const prof = await p(
      `INSERT INTO students (user_id, matric_number, level_id, department_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, matric, levelId, departmentId]
    );
    return { userId, profileId: Number(prof.rows[0].id) };
  }

  studentActive100DeptId = (await makeStudent(
    "ACE2 Student Active 100 Dept",
    `${MATRIC_PREFIX}/ACTIVE-100-DEP`,
    level100Id,
    departmentId
  )).profileId;

  studentActive100FacId = (await makeStudent(
    "ACE2 Student Active 100 Fac",
    `${MATRIC_PREFIX}/ACTIVE-100-FAC`,
    level100Id,
    departmentId
  )).profileId;

  studentActive200DeptId = (await makeStudent(
    "ACE2 Student Active 200 Dept",
    `${MATRIC_PREFIX}/ACTIVE-200-DEP`,
    level200Id,
    departmentId
  )).profileId;

  studentActive300DeptId = (await makeStudent(
    "ACE2 Student Active 300 Dept",
    `${MATRIC_PREFIX}/ACTIVE-300-DEP`,
    level300Id,
    departmentId
  )).profileId;

  studentCompleted100DeptId = (await makeStudent(
    "ACE2 Student Completed 100 Dept",
    `${MATRIC_PREFIX}/COMPLETED-100-DEP`,
    level100Id,
    departmentId
  )).profileId;

  studentInactiveId = (await makeStudent(
    "ACE2 Student Inactive",
    `${MATRIC_PREFIX}/INACTIVE`,
    level100Id,
    departmentId,
    "INACTIVE"
  )).profileId;

  studentWrongLevelId = (await makeStudent(
    "ACE2 Student Wrong Level",
    `${MATRIC_PREFIX}/WRONG-LEVEL`,
    level200Id,
    departmentId
  )).profileId;

  // Student in a different department (same faculty) for faculty-scoped course
  const otherDept = await p(
    `INSERT INTO departments (code, name, faculty_id)
     VALUES ('ACE2-DEP2', 'ACE2 Department 2', $1) RETURNING id`,
    [facultyId]
  );
  const otherDeptId = Number(otherDept.rows[0].id);
  studentWrongFacultyId = (await makeStudent(
    "ACE2 Student Wrong Faculty",
    `${MATRIC_PREFIX}/WRONG-FACULTY`,
    level100Id,
    otherDeptId
  )).profileId;

  // Student in a different department (not same faculty) for dept-scoped course
  const otherFac = await p(
    `INSERT INTO faculties (code, name) VALUES ('ACE2-FAC2', 'ACE2 Faculty 2') RETURNING id`
  );
  const otherFacId = Number(otherFac.rows[0].id);
  const otherDept2 = await p(
    `INSERT INTO departments (code, name, faculty_id)
     VALUES ('ACE2-DEP3', 'ACE2 Department 3', $1) RETURNING id`,
    [otherFacId]
  );
  const otherDept2Id = Number(otherDept2.rows[0].id);
  studentWrongDeptId = (await makeStudent(
    "ACE2 Student Wrong Dept",
    `${MATRIC_PREFIX}/WRONG-DEPT`,
    level100Id,
    otherDept2Id
  )).profileId;

  // Non-student user (lecturer)
  const lectUser = await p(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACE2 Lecturer', $1, 'LECTURER', 'ACTIVE', 'ACE2_LECT') RETURNING id`,
    [await hashPassword(TEST_PASSWORD)]
  );
  studentNonStudentId = Number(lectUser.rows[0].id);
  await p(
    `INSERT INTO lecturers (user_id, staff_id, department_id)
     VALUES ($1, $2, $3)`,
    [studentNonStudentId, "ACE2/LEC/001", departmentId]
  );

  // --- Pre-seed existing registrations ---
  const reg1 = await p(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED') RETURNING id`,
    [studentActive100DeptId, offeringOpen100DeptId]
  );
  existingEnrolledRegId = Number(reg1.rows[0].id);

  const reg2 = await p(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'DROPPED') RETURNING id`,
    [studentActive100FacId, offeringOpen100DeptId]
  );
  existingDroppedRegId = Number(reg2.rows[0].id);

  const reg3 = await p(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'COMPLETED') RETURNING id`,
    [studentCompleted100DeptId, offeringOpen100DeptId]
  );
  existingCompletedRegId = Number(reg3.rows[0].id);
});

after(async () => {
  // Restore active session flag if we toggled it
  await p(
    `UPDATE academic_sessions SET is_active = false WHERE name = 'ACE2-ACTIVE'`
  );

  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests: Authentication / Authorization
// ---------------------------------------------------------------------------

test("ACE2 auth: unauthenticated request is rejected", async () => {
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100DeptId },
    ""
  );
  assert.equal(res.status, 401);
  assert.equal(errorCode(await res.json()), "UNAUTHENTICATED");
});

test("ACE2 auth: non-admin (student) is rejected", async () => {
  const token = await getStudentToken(`${MATRIC_PREFIX}/ACTIVE-100-DEP`);
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 403);
  assert.equal(errorCode(await res.json()), "FORBIDDEN");
});

test("ACE2 auth: non-admin (lecturer) is rejected", async () => {
  const token = await getLecturerToken("ACE2/LEC/001");
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 403);
  assert.equal(errorCode(await res.json()), "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Tests: Successful enrollment
// ---------------------------------------------------------------------------

test("ACE2 enrollment: valid admin enrollment succeeds", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen300DeptId}/registrations`,
    { studentId: studentActive300DeptId },
    token
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    data: { registration: { id: number; studentId: number; courseOfferingId: number; status: string; createdAt: string; updatedAt: string } };
  };
  assert.equal(body.data.registration.studentId, studentActive300DeptId);
  assert.equal(body.data.registration.courseOfferingId, offeringOpen300DeptId);
  assert.equal(body.data.registration.status, "ENROLLED");
  assert.ok(body.data.registration.id > 0);
  assert.ok(Date.parse(body.data.registration.createdAt));
  assert.ok(Date.parse(body.data.registration.updatedAt));

  // Verify the registration row exists in DB
  const reg = await p(
    `SELECT student_id, course_offering_id, status FROM course_registrations WHERE id = $1`,
    [body.data.registration.id]
  );
  assert.equal(Number(reg.rows[0].student_id), studentActive300DeptId);
  assert.equal(Number(reg.rows[0].course_offering_id), offeringOpen300DeptId);
  assert.equal(reg.rows[0].status, "ENROLLED");
});

test("ACE2 enrollment: student identity comes from studentId body field", async () => {
  const token = await getAdminToken();
  // Use faculty-scoped offering with matching student (eligible, not pre-seeded)
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100FacId}/registrations`,
    { studentId: studentActive100FacId },
    token
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.registration.studentId, studentActive100FacId);
  assert.equal(body.data.registration.courseOfferingId, offeringOpen100FacId);

  // Verify DB registration references the exact student
  const reg = await p(
    `SELECT student_id FROM course_registrations WHERE id = $1`,
    [body.data.registration.id]
  );
  assert.equal(Number(reg.rows[0].student_id), studentActive100FacId);
});

test("ACE2 enrollment: response contains only safe registration fields", async () => {
  const token = await getAdminToken();
  // Use a student that hasn't been enrolled yet
  const freshStudent = await p(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACE2 Fresh Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [await hashPassword(TEST_PASSWORD)]
  );
  const freshUserId = Number(freshStudent.rows[0].id);
  const freshProfile = await p(
    `INSERT INTO students (user_id, matric_number, level_id, department_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [freshUserId, `${MATRIC_PREFIX}/FRESH`, level100Id, departmentId]
  );
  const freshProfileId = Number(freshProfile.rows[0].id);

  try {
    const res = await postJson(
      `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
      { studentId: freshProfileId },
      token
    );
    assert.equal(res.status, 201);
    const raw = await res.text();
    assert.ok(!raw.includes("password_hash"));
    assert.ok(!raw.includes("passwordHash"));
    assert.ok(!raw.includes("session_token"));
    assert.ok(!raw.includes("challenge"));
    assert.ok(!raw.includes("credential"));
  } finally {
    // Delete registration first (FK), then student, then user
    await p(`DELETE FROM course_registrations WHERE student_id = $1`, [freshProfileId]);
    await p(`DELETE FROM students WHERE id = $1`, [freshProfileId]);
    await p(`DELETE FROM users WHERE id = $1`, [freshUserId]);
  }
});

// ---------------------------------------------------------------------------
// Tests: Invalid / missing body
// ---------------------------------------------------------------------------

test("ACE2 enrollment: missing body is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    {},
    token
  );
  assert.equal(res.status, 400);
  assert.equal(errorCode(await res.json()), "INVALID_REQUEST");
});

test("ACE2 enrollment: extra fields are rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100DeptId, matricNumber: "ACE2/SMUGGLE" },
    token
  );
  assert.equal(res.status, 400);
  assert.equal(errorCode(await res.json()), "INVALID_REQUEST");
});

test("ACE2 enrollment: non-integer studentId is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: "abc" },
    token
  );
  assert.equal(res.status, 400);
});

test("ACE2 enrollment: zero studentId is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: 0 },
    token
  );
  assert.equal(res.status, 400);
});

test("ACE2 enrollment: negative studentId is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: -1 },
    token
  );
  assert.equal(res.status, 400);
});

test("ACE2 enrollment: invalid offering ID is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/abc/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 400);
});

test("ACE2 enrollment: nonexistent offering returns 404", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/999999/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Tests: Eligibility — student
// ---------------------------------------------------------------------------

test("ACE2 enrollment: nonexistent student is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: 999999999 },
    token
  );
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "STUDENT_NOT_FOUND");
});

test("ACE2 enrollment: inactive student is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentInactiveId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "STUDENT_NOT_ACTIVE");
});

test("ACE2 enrollment: non-student user is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentNonStudentId },
    token
  );
  assert.equal(res.status, 404);
  assert.equal(errorCode(await res.json()), "STUDENT_NOT_FOUND");
});

test("ACE2 enrollment: wrong level is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentWrongLevelId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "STUDENT_WRONG_LEVEL");
});

test("ACE2 enrollment: wrong faculty is rejected (faculty-scoped course)", async () => {
  const token = await getAdminToken();
  // studentWrongDeptId is in ACE2-DEP3 (faculty ACE2-FAC2), course is ACE2-FAC
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100FacId}/registrations`,
    { studentId: studentWrongDeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "STUDENT_WRONG_FACULTY");
});

test("ACE2 enrollment: wrong department is rejected (dept-scoped course)", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentWrongDeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "STUDENT_WRONG_DEPARTMENT");
});

// ---------------------------------------------------------------------------
// Tests: Eligibility — course / offering / session
// ---------------------------------------------------------------------------

test("ACE2 enrollment: inactive course is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringInactiveCourseId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "COURSE_NOT_ACTIVE");
});

test("ACE2 enrollment: CLOSED offering is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringClosedId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "OFFERING_NOT_OPEN");
});

test("ACE2 enrollment: inactive academic session is rejected", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOldSessionId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "NO_ACTIVE_ACADEMIC_SESSION");
});

// ---------------------------------------------------------------------------
// Tests: Duplicate registrations
// ---------------------------------------------------------------------------

test("ACE2 enrollment: duplicate existing ENROLLED registration returns 409", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100DeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "ALREADY_ENROLLED");
});

test("ACE2 enrollment: duplicate DROPPED registration is not reactivated", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentActive100FacId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "ALREADY_DROPPED");

  // Verify the registration is still DROPPED
  const reg = await p(
    `SELECT status FROM course_registrations WHERE id = $1`,
    [existingDroppedRegId]
  );
  assert.equal(reg.rows[0].status, "DROPPED");
});

test("ACE2 enrollment: duplicate COMPLETED registration is not reactivated", async () => {
  const token = await getAdminToken();
  const res = await postJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    { studentId: studentCompleted100DeptId },
    token
  );
  assert.equal(res.status, 409);
  assert.equal(errorCode(await res.json()), "ALREADY_COMPLETED");

  // Verify the registration is still COMPLETED
  const reg = await p(
    `SELECT status FROM course_registrations WHERE id = $1`,
    [existingCompletedRegId]
  );
  assert.equal(reg.rows[0].status, "COMPLETED");
});

// ---------------------------------------------------------------------------
// Tests: Concurrent enrollment safety
// ---------------------------------------------------------------------------

test("ACE2 enrollment: concurrent requests cannot create duplicate registrations", async () => {
  // Create a fresh level-100 student in ACE2-DEP (faculty ACE2-FAC)
  // Use existing OPEN faculty-scoped offering (offeringOpen100FacId) to avoid UNIQUE constraint
  const freshUser = await p(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACE2 Conc Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [await hashPassword(TEST_PASSWORD)]
  );
  const freshUserId = Number(freshUser.rows[0].id);
  const freshProfile = await p(
    `INSERT INTO students (user_id, matric_number, level_id, department_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [freshUserId, `${MATRIC_PREFIX}/CONC`, level100Id, departmentId]
  );
  const freshProfileId = Number(freshProfile.rows[0].id);

  const offeringId = offeringOpen100FacId;

  try {
    const token = await getAdminToken();
    const [a, b] = await Promise.all([
      postJson(
        `/api/admin/course-offerings/${offeringId}/registrations`,
        { studentId: freshProfileId },
        token
      ),
      postJson(
        `/api/admin/course-offerings/${offeringId}/registrations`,
        { studentId: freshProfileId },
        token
      ),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [201, 409], "one creates, the other gets conflict");

    const count = await p(
      `SELECT count(*)::int AS n FROM course_registrations
       WHERE student_id = $1 AND course_offering_id = $2 AND status = 'ENROLLED'`,
      [freshProfileId, offeringId]
    );
    assert.equal(count.rows[0].n, 1, "exactly one ENROLLED registration exists");
  } finally {
    await p(`DELETE FROM course_registrations WHERE student_id = $1 AND course_offering_id = $2`, [freshProfileId, offeringId]);
    await p(`DELETE FROM students WHERE id = $1`, [freshProfileId]);
    await p(`DELETE FROM users WHERE id = $1`, [freshUserId]);
  }
});

// ---------------------------------------------------------------------------
// Tests: Audit log
// ---------------------------------------------------------------------------

test("ACE2 enrollment: successful enrollment writes an audit entry", async () => {
  // Create a fresh student for a clean audit check
  const auditStudent = await p(
    `INSERT INTO users (name, password_hash, role, status, username)
     VALUES ('ACE2 Audit Student', $1, 'STUDENT', 'ACTIVE', NULL) RETURNING id`,
    [await hashPassword(TEST_PASSWORD)]
  );
  const auditUserId = Number(auditStudent.rows[0].id);
  const auditProfile = await p(
    `INSERT INTO students (user_id, matric_number, level_id, department_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [auditUserId, `${MATRIC_PREFIX}/AUDIT`, level100Id, departmentId]
  );
  const auditProfileId = Number(auditProfile.rows[0].id);

  try {
    const token = await getAdminToken();
    const res = await postJson(
      `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
      { studentId: auditProfileId },
      token
    );
    assert.equal(res.status, 201);

    const audit = await p(
      `SELECT user_id, action, entity_type, entity_id, description
       FROM audit_logs
       WHERE action = 'STUDENT_COURSE_ENROLLMENT'
         AND entity_type = 'course_registrations'
       ORDER BY id DESC
       LIMIT 1`
    );
    assert.equal(Number(audit.rows[0].user_id), adminUserId);
    assert.equal(audit.rows[0].action, "STUDENT_COURSE_ENROLLMENT");
    assert.equal(audit.rows[0].entity_type, "course_registrations");
    assert.ok(Number(audit.rows[0].entity_id) > 0);
    const desc = audit.rows[0].description as string;
    assert.ok(desc.includes("ACE2/AUDIT"));
    assert.ok(desc.includes("ACE2 Admin"));
  } finally {
    // Delete registration first (FK), then student, then user
    await p(`DELETE FROM course_registrations WHERE student_id = $1`, [auditProfileId]);
    await p(`DELETE FROM students WHERE id = $1`, [auditProfileId]);
    await p(`DELETE FROM users WHERE id = $1`, [auditUserId]);
  }
});

// ---------------------------------------------------------------------------
// Tests: Roster endpoint (GET)
// ---------------------------------------------------------------------------

test("ACE2 roster: admin can retrieve the roster", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    token
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      courseOffering: { id: number; courseCode: string; courseTitle: string; academicSession: string; semester: string; level: { id: number; name: number }; status: string };
      total: number;
      items: Array<{
        registrationId: number;
        studentId: number;
        matricNumber: string;
        studentName: string;
        department: { id: number; name: string; code: string };
        level: { id: number; name: number };
        status: string;
        registeredAt: string;
      }>;
    };
  };
  assert.ok(body.data.courseOffering);
  assert.equal(body.data.courseOffering.id, offeringOpen100DeptId);
  assert.ok(body.data.total >= 3); // ENROLLED + DROPPED + COMPLETED pre-seeded
  assert.ok(Array.isArray(body.data.items));
});

test("ACE2 roster: status filter works", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations?status=ENROLLED`,
    token
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { items: Array<{ status: string }> } };
  assert.ok(body.data.items.every((item) => item.status === "ENROLLED"));
});

test("ACE2 roster: matric search works", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations?matricNumber=${encodeURIComponent("ACE2/ACTIVE-100-DEP")}`,
    token
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { items: Array<{ matricNumber: string }> } };
  assert.ok(body.data.items.some((item) => item.matricNumber.includes("ACTIVE-100-DEP")));
});

test("ACE2 roster: name search works", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations?studentName=${encodeURIComponent("ACE2 Student Active 100 Dept")}`,
    token
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { items: Array<{ studentName: string }> } };
  assert.ok(body.data.items.some((item) => item.studentName.includes("Active 100 Dept")));
});

test("ACE2 roster: pagination works", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations?limit=1&offset=0`,
    token
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { items: unknown[]; total: number } };
  assert.equal(body.data.items.length, 1);
  assert.ok(typeof body.data.total === "number");
});

test("ACE2 roster: unknown offering returns 404", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/999999/registrations`,
    token
  );
  assert.equal(res.status, 404);
});

test("ACE2 roster: no sensitive data in response", async () => {
  const token = await getAdminToken();
  const res = await getJson(
    `/api/admin/course-offerings/${offeringOpen100DeptId}/registrations`,
    token
  );
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes("password_hash"));
  assert.ok(!raw.includes("session_token"));
  assert.ok(!raw.includes("challenge"));
});
