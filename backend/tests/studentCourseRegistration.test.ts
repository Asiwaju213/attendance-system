import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { app } from "../src/app";
import { authConfig } from "../src/config/auth";
import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";
import { generateSessionToken, hashSessionToken } from "../src/lib/sessions";
import { createSession } from "../src/services/sessionStore";

const TEST_PASSWORD = "regc-test-password";
const ADMIN_USERNAME = "regc_admin";

let server: Server;
let baseUrl: string;
let passwordHash: string;

let studentAUserId = 0;
let studentBUserId = 0;
let studentCUserId = 0;
let studentL3UserId = 0;
let inactiveStudentUserId = 0;
let adminUserId = 0;

let studentAProfileId = 0;
let studentBProfileId = 0;
let studentCProfileId = 0;
let lecturer1ProfileId = 0;
let lecturer2ProfileId = 0;

let faculty1Id = 0;
let faculty2Id = 0;
let department1Id = 0;
let department2Id = 0;
let level200Id = 0;
let level300Id = 0;

let activeSessionId = 0;
let oldSessionId = 0;
let firstSemesterId = 0;
let secondSemesterId = 0;

let courseCSC201Id = 0;
let courseCSC202Id = 0;
let courseCSC201XId = 0;
let courseCSC301Id = 0;
let courseB200Id = 0;
let courseGST200Id = 0;
let courseGST200F2Id = 0;
let courseGST300Id = 0;
let courseGST2NDId = 0;

let offeringCSC201 = 0;
let offeringCSC202 = 0;
let offeringCSC201Closed = 0;
let offeringCSC201Old = 0;
let offeringCSC201X = 0;
let offeringCSC301 = 0;
let offeringB200 = 0;
let offeringGST200 = 0;
let offeringGST200F2 = 0;
let offeringGST300 = 0;
let offeringGST2ND = 0;

const ALL_USER_IDS = () => [
  studentAUserId,
  studentBUserId,
  studentCUserId,
  studentL3UserId,
  inactiveStudentUserId,
  adminUserId,
];

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
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res);
  assert.ok(token);
  return token;
}

async function countEnrollments(studentProfileId: number): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM course_registrations WHERE student_id = $1`,
    [studentProfileId]
  );
  return res.rows[0].n;
}

async function hasEnrollment(studentProfileId: number, offeringId: number): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM course_registrations
     WHERE student_id = $1 AND course_offering_id = $2 AND status = 'ENROLLED'
     LIMIT 1`,
    [studentProfileId, offeringId]
  );
  return (res.rowCount ?? 0) > 0;
}

async function cleanupScopedData(): Promise<void> {
  await pool.query(
    `DELETE FROM course_registrations
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'REGC%')
          OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'REGC%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offering_lecturers
     WHERE course_offering_id IN (
       SELECT id FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'REGC%')
          OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'REGC%')
     )`
  );
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE 'REGC%')
        OR academic_session_id IN (SELECT id FROM academic_sessions WHERE name LIKE 'REGC%')`
  );
  await pool.query(`DELETE FROM academic_sessions WHERE name LIKE 'REGC%'`);
  await pool.query(`DELETE FROM courses WHERE course_code LIKE 'REGC%'`);
  await pool.query(`DELETE FROM students WHERE matric_number LIKE 'REGC%'`);
  await pool.query(`DELETE FROM lecturers WHERE staff_id LIKE 'REGC%'`);
  
  // Delete sessions for users matching our test patterns BEFORE deleting users
  await pool.query(
    `DELETE FROM sessions
     WHERE user_id IN (
       SELECT id FROM users WHERE name LIKE 'Regc %' OR name LIKE 'REGC %' OR username = $1
     )`,
    [ADMIN_USERNAME]
  );
  
  await pool.query(`DELETE FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  await pool.query(
    `DELETE FROM users WHERE name LIKE 'Regc %' OR name LIKE 'REGC %'`
  );
  await pool.query(`DELETE FROM departments WHERE code LIKE 'REGC%'`);
  await pool.query(`DELETE FROM faculties WHERE code LIKE 'REGC%'`);
}

before(async () => {
  await cleanupScopedData();
  passwordHash = await hashPassword(TEST_PASSWORD);

  await pool.query(`UPDATE academic_sessions SET is_active = false`);

  const faculty1 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Regc Faculty One', 'REGC-FAC') RETURNING id`
  );
  faculty1Id = Number(faculty1.rows[0].id);
  const faculty2 = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Regc Faculty Two', 'REGC-FAC2') RETURNING id`
  );
  faculty2Id = Number(faculty2.rows[0].id);

  const dep1 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Regc Department One', 'REGC-DEP', $1) RETURNING id`,
    [faculty1Id]
  );
  department1Id = Number(dep1.rows[0].id);
  const dep2 = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Regc Department Two', 'REGC-DEP2', $1) RETURNING id`,
    [faculty2Id]
  );
  department2Id = Number(dep2.rows[0].id);

  const levels = await pool.query(`SELECT id, name FROM levels WHERE name IN (100, 200, 300)`);
  for (const row of levels.rows) {
    const name = Number(row.name);
    const id = Number(row.id);
    if (name === 200) level200Id = id;
    if (name === 300) level300Id = id;
  }

  const sessions = await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ('REGC-ACTIVE', true), ('REGC-OLD', false)
     RETURNING id, name`
  );
  for (const row of sessions.rows) {
    if (row.name === "REGC-ACTIVE") activeSessionId = Number(row.id);
    if (row.name === "REGC-OLD") oldSessionId = Number(row.id);
  }

  const semesters = await pool.query(`SELECT id, name FROM semesters`);
  for (const row of semesters.rows) {
    if (row.name === "First Semester") firstSemesterId = Number(row.id);
    if (row.name === "Second Semester") secondSemesterId = Number(row.id);
  }

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

  studentAUserId = await insertUser("Regc Student A", "STUDENT", "ACTIVE", null);
  studentBUserId = await insertUser("Regc Student B", "STUDENT", "ACTIVE", null);
  studentCUserId = await insertUser("Regc Student C", "STUDENT", "ACTIVE", null);
  studentL3UserId = await insertUser("Regc Student L3", "STUDENT", "ACTIVE", null);
  inactiveStudentUserId = await insertUser("Regc Student Inactive", "STUDENT", "INACTIVE", null);
  await insertUser("Regc Lecturer One", "LECTURER", "ACTIVE", null);
  await insertUser("Regc Lecturer Two", "LECTURER", "ACTIVE", null);
  adminUserId = await insertUser("Regc Admin", "ADMIN", "ACTIVE", ADMIN_USERNAME);

  async function insertStudent(
    userId: number,
    matric: string,
    depId: number,
    levelId: number
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO students (user_id, matric_number, department_id, level_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, matric, depId, levelId]
    );
    return Number(res.rows[0].id);
  }

  studentAProfileId = await insertStudent(studentAUserId, "REGC/STU/A", department1Id, level200Id);
  studentBProfileId = await insertStudent(studentBUserId, "REGC/STU/B", department2Id, level200Id);
  studentCProfileId = await insertStudent(studentCUserId, "REGC/STU/C", department1Id, level200Id);
  await insertStudent(studentL3UserId, "REGC/STU/L3", department1Id, level300Id);
  await insertStudent(inactiveStudentUserId, "REGC/STU/INACTIVE", department1Id, level200Id);

  async function insertLecturer(userId: number, staffId: string): Promise<number> {
    const res = await pool.query(
      `INSERT INTO lecturers (user_id, staff_id, department_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, staffId, department1Id]
    );
    return Number(res.rows[0].id);
  }

  const lecturer1UserIdRes = await pool.query(
    `SELECT id FROM users WHERE name = 'Regc Lecturer One' LIMIT 1`
  );
  lecturer1ProfileId = await insertLecturer(Number(lecturer1UserIdRes.rows[0].id), "REGC/LEC/1");
  const lecturer2UserIdRes = await pool.query(
    `SELECT id FROM users WHERE name = 'Regc Lecturer Two' LIMIT 1`
  );
  lecturer2ProfileId = await insertLecturer(Number(lecturer2UserIdRes.rows[0].id), "REGC/LEC/2");

  async function insertCourse(
    code: string,
    title: string,
    levelId: number,
    owner: { type: "faculty"; id: number } | { type: "department"; id: number },
    status = "ACTIVE"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO courses (course_code, title, level_id, faculty_id, department_id, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        code,
        title,
        levelId,
        owner.type === "faculty" ? owner.id : null,
        owner.type === "department" ? owner.id : null,
        status,
      ]
    );
    return Number(res.rows[0].id);
  }

  courseCSC201Id = await insertCourse("REGC-CSC201", "Data Structures", level200Id, {
    type: "department",
    id: department1Id,
  });
  courseCSC202Id = await insertCourse("REGC-CSC202", "Advanced Algorithms", level200Id, {
    type: "department",
    id: department1Id,
  });
  courseCSC201XId = await insertCourse("REGC-CSC201X", "Legacy Course", level200Id, {
    type: "department",
    id: department1Id,
  }, "INACTIVE");
  courseCSC301Id = await insertCourse("REGC-CSC301", "Systems Design", level300Id, {
    type: "department",
    id: department1Id,
  });
  courseB200Id = await insertCourse("REGC-BUS200", "Business Accounting", level200Id, {
    type: "department",
    id: department2Id,
  });
  courseGST200Id = await insertCourse("REGC-GST200", "General Studies 200", level200Id, {
    type: "faculty",
    id: faculty1Id,
  });
  courseGST200F2Id = await insertCourse("REGC-GST200F2", "General Studies Fac2", level200Id, {
    type: "faculty",
    id: faculty2Id,
  });
  courseGST300Id = await insertCourse("REGC-GST300", "General Studies 300", level300Id, {
    type: "faculty",
    id: faculty1Id,
  });
  courseGST2NDId = await insertCourse("REGC-GST2ND", "General Studies Sem2", level200Id, {
    type: "faculty",
    id: faculty1Id,
  });

  async function insertOffering(
    courseId: number,
    sessionId: number,
    semesterId: number,
    status = "OPEN"
  ): Promise<number> {
    const res = await pool.query(
      `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [courseId, sessionId, semesterId, status]
    );
    return Number(res.rows[0].id);
  }

  offeringCSC201 = await insertOffering(courseCSC201Id, activeSessionId, firstSemesterId);
  offeringCSC202 = await insertOffering(courseCSC202Id, activeSessionId, firstSemesterId);
  offeringCSC201Closed = await insertOffering(courseCSC201Id, activeSessionId, secondSemesterId, "CLOSED");
  offeringCSC201Old = await insertOffering(courseCSC201Id, oldSessionId, firstSemesterId);
  offeringCSC201X = await insertOffering(courseCSC201XId, activeSessionId, firstSemesterId);
  offeringCSC301 = await insertOffering(courseCSC301Id, activeSessionId, firstSemesterId);
  offeringB200 = await insertOffering(courseB200Id, activeSessionId, firstSemesterId);
  offeringGST200 = await insertOffering(courseGST200Id, activeSessionId, firstSemesterId);
  offeringGST200F2 = await insertOffering(courseGST200F2Id, activeSessionId, firstSemesterId);
  offeringGST300 = await insertOffering(courseGST300Id, activeSessionId, firstSemesterId);
  offeringGST2ND = await insertOffering(courseGST2NDId, activeSessionId, secondSemesterId);

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2), ($3, $4)`,
    [offeringCSC201, lecturer1ProfileId, offeringGST200, lecturer2ProfileId]
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await pool.query(
    `UPDATE academic_sessions SET is_active = false WHERE name = 'REGC-ACTIVE'`
  );
  await cleanupScopedData();

  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Authentication / authorization
// ---------------------------------------------------------------------------

test("REGC auth: an unauthenticated request is rejected", async () => {
  const res = await get("/api/student/registration/courses");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("REGC auth: a lecturer cannot access the student endpoint", async () => {
  const res = await postJson("/api/auth/lecturer/login", {
    staffId: "REGC/LEC/1",
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const courses = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(courses.status, 403);
  assert.equal((await courses.json()).error, "FORBIDDEN");

  const submit = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201] },
    cookieHeader(token)
  );
  assert.equal(submit.status, 403);
});

test("REGC auth: an admin cannot use the student endpoint as a student", async () => {
  const res = await postJson("/api/auth/admin/login", {
    username: ADMIN_USERNAME,
    password: TEST_PASSWORD,
  });
  assert.equal(res.status, 200);
  const token = cookieFrom(res)!;

  const courses = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(courses.status, 403);
  assert.equal((await courses.json()).error, "FORBIDDEN");
});

test("REGC auth: an inactive student is rejected", async () => {
  const token = generateSessionToken();
  await createSession(
    inactiveStudentUserId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  );

  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "UNAUTHENTICATED");
});

test("REGC auth: an authenticated active student can access the endpoint", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { academicSession: { id: number; name: string } };
  };
  assert.deepEqual(body.data.academicSession, {
    id: activeSessionId,
    name: "REGC-ACTIVE",
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("REGC eligibility: student sees department and faculty courses for their own level", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      academicSession: { id: number; name: string };
      courses: Array<Record<string, unknown>>;
    };
  };

  assert.deepEqual(body.data.academicSession, {
    id: activeSessionId,
    name: "REGC-ACTIVE",
  });

  const offeringIds = body.data.courses.map((c) => c.offeringId).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(
    offeringIds,
    [offeringCSC201, offeringCSC202, offeringGST200, offeringGST2ND].sort((a, b) => a - b),
    "only department (own) and faculty (own) courses at level 200 in the active session"
  );
  for (const course of body.data.courses) {
    assert.equal(course.level, 200);
    assert.equal(course.isRegistered, false);
  }

  const csc201 = body.data.courses.find((c) => c.offeringId === offeringCSC201)!;
  assert.equal(csc201.courseId, courseCSC201Id);
  assert.equal(csc201.courseCode, "REGC-CSC201");
  assert.equal(csc201.title, "Data Structures");
  assert.equal(csc201.scope, "DEPARTMENT");
  assert.deepEqual(csc201.department, {
    id: department1Id,
    name: "Regc Department One",
    code: "REGC-DEP",
  });
  assert.equal(csc201.faculty, null);

  const gst200 = body.data.courses.find((c) => c.offeringId === offeringGST200)!;
  assert.equal(gst200.scope, "FACULTY");
  assert.deepEqual(gst200.faculty, {
    id: faculty1Id,
    name: "Regc Faculty One",
    code: "REGC-FAC",
  });
  assert.equal(gst200.department, null);
});

test("REGC eligibility: a student in another department/faculty sees only their own scope", async () => {
  const token = await loginStudent("REGC/STU/B");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { courses: Array<{ offeringId: number }> } };
  const ids = body.data.courses.map((c) => c.offeringId).sort((a, b) => a - b);
  assert.deepEqual(ids, [offeringB200, offeringGST200F2].sort((a, b) => a - b));
});

test("REGC eligibility: another level's courses are not shown", async () => {
  const token = await loginStudent("REGC/STU/L3");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { courses: Array<{ offeringId: number; level: number }> } };
  const ids = body.data.courses.map((c) => c.offeringId).sort((a, b) => a - b);
  assert.deepEqual(ids, [offeringCSC301, offeringGST300].sort((a, b) => a - b));
  for (const course of body.data.courses) {
    assert.equal(course.level, 300);
  }
});

test("REGC eligibility: inactive courses, closed offerings, and other sessions are excluded", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  const body = (await res.json()) as { data: { courses: Array<{ offeringId: number }> } };
  const ids = new Set(body.data.courses.map((c) => c.offeringId));

  assert.ok(!ids.has(offeringCSC201Closed), "closed offering must not appear");
  assert.ok(!ids.has(offeringCSC201Old), "offering from a non-active session must not appear");
  assert.ok(!ids.has(offeringCSC201X), "inactive course must not appear");
  assert.ok(!ids.has(offeringCSC301), "wrong level must not appear");
  assert.ok(!ids.has(offeringB200), "another department must not appear");
  assert.ok(!ids.has(offeringGST200F2), "another faculty must not appear");
});

test("REGC eligibility: lecturer information is returned correctly", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  const body = (await res.json()) as { data: { courses: Array<Record<string, unknown>> } };

  const csc201 = body.data.courses.find((c) => c.offeringId === offeringCSC201)!;
  assert.deepEqual(csc201.lecturers, [{ id: lecturer1ProfileId, name: "Regc Lecturer One" }]);

  const gst2nd = body.data.courses.find((c) => c.offeringId === offeringGST2ND)!;
  assert.deepEqual(gst2nd.lecturers, []);
});

test("REGC eligibility: semester metadata is carried per offering", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  const body = (await res.json()) as {
    data: { courses: Array<{ offeringId: number; semester: { id: number; name: string } }> };
  };

  const csc201 = body.data.courses.find((c) => c.offeringId === offeringCSC201)!;
  assert.deepEqual(csc201.semester, { id: firstSemesterId, name: "First Semester" });
  const gst2nd = body.data.courses.find((c) => c.offeringId === offeringGST2ND)!;
  assert.deepEqual(gst2nd.semester, { id: secondSemesterId, name: "Second Semester" });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("REGC registration: a valid course selection succeeds", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201] },
    cookieHeader(token)
  );

  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    data: { registered: Array<{ offeringId: number; courseCode: string; title: string }> };
  };
  assert.deepEqual(body.data.registered, [
    { offeringId: offeringCSC201, courseCode: "REGC-CSC201", title: "Data Structures" },
  ]);
  assert.deepEqual(body.data.alreadyRegistered, []);
  assert.equal(await countEnrollments(studentAProfileId), 1);
  assert.equal(await hasEnrollment(studentAProfileId, offeringCSC201), true);
});

test("REGC registration: multiple courses can be registered in one request", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringGST200, offeringGST2ND] },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    data: { registered: Array<{ offeringId: number }> };
  };
  assert.deepEqual(
    body.data.registered.map((r) => r.offeringId).sort((a, b) => a - b),
    [offeringGST200, offeringGST2ND].sort((a, b) => a - b)
  );
  assert.equal(await countEnrollments(studentAProfileId), 3);
});

test("REGC registration: duplicate offering IDs in one request are rejected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringGST200, offeringGST200] },
    cookieHeader(token)
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "INVALID_REQUEST");
  assert.equal(await countEnrollments(studentAProfileId), 3);
});

test("REGC registration: already-registered courses are not duplicated", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201] },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { registered: unknown[]; alreadyRegistered: unknown[] } };
  assert.deepEqual(body.data.registered, []);
  assert.equal(body.data.alreadyRegistered.length, 1);
  assert.equal(await countEnrollments(studentAProfileId), 3);
});

test("REGC registration: a new valid course can be added later without touching existing rows", async () => {
  const token = await loginStudent("REGC/STU/A");
  const before = await countEnrollments(studentAProfileId);

  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC202] },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    data: { registered: Array<{ offeringId: number; courseCode: string; title: string }> };
  };
  assert.deepEqual(body.data.registered, [
    { offeringId: offeringCSC202, courseCode: "REGC-CSC202", title: "Advanced Algorithms" },
  ]);

  assert.equal(await countEnrollments(studentAProfileId), before + 1);
  assert.equal(await hasEnrollment(studentAProfileId, offeringCSC201), true);
  assert.equal(await hasEnrollment(studentAProfileId, offeringGST200), true);
});

test("REGC registration: resubmitting the full list is safely idempotent", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201, offeringCSC202, offeringGST200, offeringGST2ND] },
    cookieHeader(token)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { registered: unknown[]; alreadyRegistered: Array<{ offeringId: number }> };
  };
  assert.deepEqual(body.data.registered, []);
  assert.equal(body.data.alreadyRegistered.length, 4);
  assert.equal(await countEnrollments(studentAProfileId), 4);
});

test("REGC registration: one invalid offering fails the entire new batch", async () => {
  const token = await loginStudent("REGC/STU/C");
  const before = await countEnrollments(studentCProfileId);

  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringGST200, offeringB200] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");

  assert.equal(await countEnrollments(studentCProfileId), before, "no partial registrations");
  assert.equal(await hasEnrollment(studentCProfileId, offeringGST200), false);
  assert.equal(await hasEnrollment(studentCProfileId, offeringB200), false);
});

test("REGC registration: a closed offering cannot be selected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201Closed] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
});

test("REGC registration: an inactive course cannot be selected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201X] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
});

test("REGC registration: an offering from a non-active session cannot be selected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringCSC201Old] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
});

test("REGC registration: a wrong-level offering cannot be selected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [offeringGST300] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
});

test("REGC registration: a nonexistent offering is rejected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const before = await countEnrollments(studentAProfileId);
  const res = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [999999] },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
  assert.equal(await countEnrollments(studentAProfileId), before);
});

test("REGC registration: client-supplied identity fields are ignored", async () => {
  const token = await loginStudent("REGC/STU/C");
  const res = await postJson(
    "/api/student/registration/courses",
    {
      offeringIds: [offeringGST200],
      studentId: 999,
      departmentId: 999,
      facultyId: 999,
      levelId: 999,
      academicSessionId: 999,
      semesterId: 999,
    },
    cookieHeader(token)
  );
  assert.equal(res.status, 201);
  assert.equal(await hasEnrollment(studentCProfileId, offeringGST200), true);
});

test("REGC registration: identity spoofing cannot bypass eligibility", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await postJson(
    "/api/student/registration/courses",
    {
      offeringIds: [offeringB200],
      departmentId: department2Id,
      facultyId: faculty2Id,
      levelId: level200Id,
      studentId: studentBProfileId,
    },
    cookieHeader(token)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "INVALID_COURSE_SELECTION");
  assert.equal(await hasEnrollment(studentAProfileId, offeringB200), false);
});

test("REGC registration: malformed selections are rejected", async () => {
  const token = await loginStudent("REGC/STU/A");
  const headers = cookieHeader(token);

  const noArray = await postJson(
    "/api/student/registration/courses",
    { offeringIds: "10" },
    headers
  );
  assert.equal(noArray.status, 400);

  const empty = await postJson("/api/student/registration/courses", { offeringIds: [] }, headers);
  assert.equal(empty.status, 400);

  const missing = await postJson("/api/student/registration/courses", {}, headers);
  assert.equal(missing.status, 400);

  const float = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [1.5] },
    headers
  );
  assert.equal(float.status, 400);

  const string = await postJson(
    "/api/student/registration/courses",
    { offeringIds: ["10"] },
    headers
  );
  assert.equal(string.status, 400);

  const negative = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [-1] },
    headers
  );
  assert.equal(negative.status, 400);

  const zero = await postJson(
    "/api/student/registration/courses",
    { offeringIds: [0] },
    headers
  );
  assert.equal(zero.status, 400);
});

// ---------------------------------------------------------------------------
// Transaction / race safety
// ---------------------------------------------------------------------------

test("REGC transaction: concurrent duplicate requests create a single registration", async () => {
  const token = await loginStudent("REGC/STU/C");

  const [a, b] = await Promise.all([
    postJson(
      "/api/student/registration/courses",
      { offeringIds: [offeringCSC202] },
      cookieHeader(token)
    ),
    postJson(
      "/api/student/registration/courses",
      { offeringIds: [offeringCSC202] },
      cookieHeader(token)
    ),
  ]);

  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 201], "one request creates, the other is an idempotent no-op");

  const bodyA = (await a.json()) as { data: { registered: Array<{ offeringId: number }> } };
  const bodyB = (await b.json()) as { data: { registered: Array<{ offeringId: number }> } };
  const totalRegistered = bodyA.data.registered.length + bodyB.data.registered.length;
  assert.equal(totalRegistered, 1, "exactly one registration was created across both requests");

  const res = await pool.query(
    `SELECT count(*)::int AS n FROM course_registrations
     WHERE student_id = $1 AND course_offering_id = $2 AND status = 'ENROLLED'`,
    [studentCProfileId, offeringCSC202]
  );
  assert.equal(res.rows[0].n, 1);
});

// ---------------------------------------------------------------------------
// Regression / state
// ---------------------------------------------------------------------------

test("REGC regression: previously registered courses are flagged after registration", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await get("/api/student/registration/courses", cookieHeader(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { courses: Array<{ offeringId: number; isRegistered: boolean }> };
  };

  const byOffering = new Map(body.data.courses.map((c) => [c.offeringId, c.isRegistered]));
  assert.equal(byOffering.get(offeringCSC201), true);
  assert.equal(byOffering.get(offeringCSC202), true);
  assert.equal(byOffering.get(offeringGST200), true);
  assert.equal(byOffering.get(offeringGST2ND), true);
});

test("REGC regression: no unregister endpoint is exposed", async () => {
  const token = await loginStudent("REGC/STU/A");
  const res = await fetch(baseUrl + "/api/student/registration/courses", {
    method: "DELETE",
    headers: cookieHeader(token),
  });
  assert.equal(res.status, 404);
});