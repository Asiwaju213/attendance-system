import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool } from "../src/db/pool";

const TEST_PREFIX = "SCHEMA";

let facultyAId = 0;
let facultyBId = 0;
let level100Id = 0;
let deptAId = 0;
let deptBId = 0;
let deptCId = 0;
let facultyWideCourseId = 0;
let departmentCourseId = 0;

const facultyIds: number[] = [];
const departmentIds: number[] = [];
const courseIds: number[] = [];

function rejectsWith(pattern: RegExp) {
  return (error: unknown) => pattern.test((error as Error).message);
}

before(async () => {
  // Remove leftovers from a previously interrupted run (safe re-run).
  await pool.query(
    `DELETE FROM course_offerings
     WHERE course_id IN (SELECT id FROM courses WHERE course_code LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM courses WHERE course_code LIKE $1`, [
    `${TEST_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM departments WHERE code LIKE $1`, [
    `${TEST_PREFIX}%`,
  ]);
  await pool.query(`DELETE FROM faculties WHERE code LIKE $1`, [`${TEST_PREFIX}%`]);

  const facA = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Test', $1) RETURNING id`,
    [`${TEST_PREFIX}FAC`]
  );
  facultyAId = Number(facA.rows[0].id);
  facultyIds.push(facultyAId);

  const facB = await pool.query(
    `INSERT INTO faculties (name, code) VALUES ('Faculty of Other', $1) RETURNING id`,
    [`${TEST_PREFIX}FAC2`]
  );
  facultyBId = Number(facB.rows[0].id);
  facultyIds.push(facultyBId);

  const level = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  level100Id = Number(level.rows[0].id);

  const deptA = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Test Department A', $1, $2) RETURNING id`,
    [`${TEST_PREFIX}DEPA`, facultyAId]
  );
  deptAId = Number(deptA.rows[0].id);
  departmentIds.push(deptAId);

  const deptB = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Test Department B', $1, $2) RETURNING id`,
    [`${TEST_PREFIX}DEPB`, facultyAId]
  );
  deptBId = Number(deptB.rows[0].id);
  departmentIds.push(deptBId);

  const deptC = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('Test Department C', $1, $2) RETURNING id`,
    [`${TEST_PREFIX}DEPC`, facultyBId]
  );
  deptCId = Number(deptC.rows[0].id);
  departmentIds.push(deptCId);
});

after(async () => {
  await pool.query(`DELETE FROM course_offerings WHERE course_id = ANY($1::BIGINT[])`, [
    courseIds,
  ]);
  await pool.query(`DELETE FROM courses WHERE id = ANY($1::BIGINT[])`, [courseIds]);
  await pool.query(`DELETE FROM departments WHERE id = ANY($1::BIGINT[])`, [
    departmentIds,
  ]);
  await pool.query(`DELETE FROM faculties WHERE id = ANY($1::BIGINT[])`, [facultyIds]);
  await pool.end();
});

test("migration 004 is applied: faculties, ownership columns, CHECK, and bootstrap faculty exist", async () => {
  const facultyCols = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = 'faculties'
        AND column_name IN ('id', 'name', 'code', 'status')
      ORDER BY column_name`
  );
  assert.deepEqual(
    facultyCols.rows.map((row) => row.column_name),
    ["code", "id", "name", "status"]
  );

  const deptFaculty = await pool.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_name = 'departments' AND column_name = 'faculty_id'`
  );
  assert.equal(deptFaculty.rows[0].is_nullable, "NO");

  const courseCols = await pool.query(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'courses'
        AND column_name IN ('faculty_id', 'department_id')
      ORDER BY column_name`
  );
  const byName = new Map(
    courseCols.rows.map((row) => [row.column_name as string, row.is_nullable as string])
  );
  assert.equal(byName.get("faculty_id"), "YES");
  assert.equal(byName.get("department_id"), "YES");

  const singleOwner = await pool.query(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid = 'courses'::regclass
        AND conname = 'chk_courses_single_owner'`
  );
  assert.equal(singleOwner.rowCount, 1);

  const unassigned = await pool.query(
    `SELECT id FROM faculties WHERE code = 'UNASSIGNED'`
  );
  assert.equal(unassigned.rowCount, 1);
});

test("a faculty can have multiple departments", async () => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM departments WHERE faculty_id = $1`,
    [facultyAId]
  );
  assert.ok(result.rows[0].count >= 2, "the same faculty owns at least two departments");
  assert.notEqual(deptAId, deptBId);
});

test("a department belongs to exactly one faculty", async () => {
  const result = await pool.query(
    `SELECT faculty_id FROM departments WHERE id = $1`,
    [deptAId]
  );
  assert.equal(Number(result.rows[0].faculty_id), facultyAId);

  await assert.rejects(
    pool.query(
      `INSERT INTO departments (name, code, faculty_id)
       VALUES ('Bogus', 'SCHEMA-BAD-FK', 999999)`
    ),
    rejectsWith(/violates foreign key constraint/)
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO departments (name, code) VALUES ('No Faculty', 'SCHEMA-NO-FAC')`
    ),
    rejectsWith(/violates not-null constraint/)
  );
});

test("a faculty-wide course can exist", async () => {
  const result = await pool.query(
    `INSERT INTO courses (course_code, title, faculty_id, level_id)
     VALUES ('SCHEMA-FAC-C', 'Faculty-wide Course', $1, $2)
     RETURNING id, department_id, faculty_id, level_id`,
    [facultyAId, level100Id]
  );
  facultyWideCourseId = Number(result.rows[0].id);
  courseIds.push(facultyWideCourseId);

  assert.equal(result.rows[0].department_id, null);
  assert.equal(Number(result.rows[0].faculty_id), facultyAId);
  assert.equal(Number(result.rows[0].level_id), level100Id);
});

test("a department-specific course can exist", async () => {
  const result = await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ('SCHEMA-DEPT-C', 'Department Course', $1, $2)
     RETURNING id, department_id, faculty_id, level_id`,
    [deptAId, level100Id]
  );
  departmentCourseId = Number(result.rows[0].id);
  courseIds.push(departmentCourseId);

  assert.equal(Number(result.rows[0].department_id), deptAId);
  assert.equal(result.rows[0].faculty_id, null);
  assert.equal(Number(result.rows[0].level_id), level100Id);
});

test("a course cannot have both faculty_id and department_id", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, faculty_id, department_id, level_id)
       VALUES ('SCHEMA-BOTH-C', 'Both Owners', $1, $2, $3)`,
      [facultyAId, deptAId, level100Id]
    ),
    rejectsWith(/violates check constraint/)
  );
});

test("a course cannot have neither faculty_id nor department_id", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, level_id)
       VALUES ('SCHEMA-NONE-C', 'No Owner', $1)`,
      [level100Id]
    ),
    rejectsWith(/violates check constraint/)
  );
});

test("level remains required for every course", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, faculty_id)
       VALUES ('SCHEMA-NOLVL-C', 'No Level', $1)`,
      [facultyAId]
    ),
    rejectsWith(/violates not-null constraint/)
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, faculty_id, level_id)
       VALUES ('SCHEMA-BADLVL-C', 'Bad Level', $1, 999)`,
      [facultyAId]
    ),
    rejectsWith(/violates foreign key constraint/)
  );
});

test("course_code remains globally unique across both scope types", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO courses (course_code, title, department_id, level_id)
       VALUES ('SCHEMA-FAC-C', 'Duplicate Code', $1, $2)`,
      [deptAId, level100Id]
    ),
    rejectsWith(/violates unique constraint/)
  );
});

test("existing course-to-offering relationships still work for both course scopes", async () => {
  const session = await pool.query(
    `INSERT INTO academic_sessions (name)
     VALUES ('SCHEMA-2026/2027')
     RETURNING id`
  );
  const sessionId = Number(session.rows[0].id);
  const semester = await pool.query(
    `SELECT id FROM semesters WHERE name = 'First Semester'`
  );
  const semesterId = Number(semester.rows[0].id);

  try {
    for (const courseId of [facultyWideCourseId, departmentCourseId]) {
      const offering = await pool.query(
        `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [courseId, sessionId, semesterId]
      );
      assert.ok(Number(offering.rows[0].id) > 0);
    }
  } finally {
    await pool.query(`DELETE FROM course_offerings WHERE academic_session_id = $1`, [
      sessionId,
    ]);
    await pool.query(`DELETE FROM academic_sessions WHERE id = $1`, [sessionId]);
  }
});

test("delete behavior stays restrictive: a department with courses cannot be deleted", async () => {
  await assert.rejects(
    pool.query(`DELETE FROM departments WHERE id = $1`, [deptAId]),
    rejectsWith(/foreign key constraint/)
  );
});

test("delete behavior stays restrictive: a faculty with departments cannot be deleted", async () => {
  await assert.rejects(
    pool.query(`DELETE FROM faculties WHERE id = $1`, [facultyAId]),
    rejectsWith(/foreign key constraint/)
  );
});

test("departments point at their faculty through the new foreign key", async () => {
  const result = await pool.query(
    `SELECT d.code, f.code AS faculty_code
       FROM departments d
       JOIN faculties f ON f.id = d.faculty_id
      WHERE d.id = ANY($1::BIGINT[])
      ORDER BY d.code`,
    [departmentIds]
  );
  assert.deepEqual(result.rows, [
    { code: "SCHEMADEPA", faculty_code: "SCHEMAFAC" },
    { code: "SCHEMADEPB", faculty_code: "SCHEMAFAC" },
    { code: "SCHEMADEPC", faculty_code: "SCHEMAFAC2" },
  ]);

  // A department in faculty B (deptC) joins its own faculty, not faculty A.
  assert.notEqual(deptCId, deptAId);
});