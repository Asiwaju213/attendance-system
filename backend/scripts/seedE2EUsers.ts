import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

export const E2E_PASSWORD = "auth-flow-test-password";

const E2E_DEPARTMENT_CODE = "E2EFLOW";
const E2E_FACULTY_CODE = "E2EFAC";

const E2E_STUDENT_MATRIC = "E2E/STU/0001";
const E2E_LECTURER_STAFF_ID = "E2E/LEC/0001";
const E2E_MONITOR_LECTURER_STAFF_ID = "E2E/LEC/0002";
const E2E_ADMIN_USERNAME = "e2e_admin";

const E2E_NETWORK_CODE = "E2E-NET-001";
const E2E_NETWORK_NAME = "E2E Test Network";
const E2E_LOCATION_NAME = "E2E Test Lecture Hall";
const E2E_ACADEMIC_SESSION_NAME = "E2E-2026/2027";
const E2E_COURSE_CODE = "E2E-101";
const E2E_COURSE_TITLE = "E2E Computer Science 101";

interface E2EUser {
  name: string;
  role: "STUDENT" | "LECTURER" | "ADMIN";
  username: string | null;
  matricNumber: string | null;
  staffId: string | null;
}

const E2E_USERS: E2EUser[] = [
  {
    name: "E2E Student",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Lecturer",
    role: "LECTURER",
    username: null,
    matricNumber: null,
    staffId: E2E_LECTURER_STAFF_ID,
  },
  {
    name: "E2E Monitor Lecturer",
    role: "LECTURER",
    username: null,
    matricNumber: null,
    staffId: E2E_MONITOR_LECTURER_STAFF_ID,
  },
  {
    name: "E2E Admin",
    role: "ADMIN",
    username: E2E_ADMIN_USERNAME,
    matricNumber: null,
    staffId: null,
  },
];

async function findE2EUserIds(): Promise<number[]> {
  const result = await pool.query(
    `SELECT u.id
       FROM users u
       LEFT JOIN students s ON s.user_id = u.id
       LEFT JOIN lecturers l ON l.user_id = u.id
      WHERE s.matric_number = $1
         OR l.staff_id = ANY($2::TEXT[])
         OR u.username = $3`,
    [
      E2E_STUDENT_MATRIC,
      [E2E_LECTURER_STAFF_ID, E2E_MONITOR_LECTURER_STAFF_ID],
      E2E_ADMIN_USERNAME,
    ]
  );
  return result.rows.map((row) => Number(row.id));
}

async function cleanup(): Promise<void> {
  const userIds = await findE2EUserIds();

  if (userIds.length > 0) {
    await pool.query(
      `DELETE FROM attendance_records
       WHERE session_id IN (
         SELECT id FROM attendance_sessions WHERE started_by_lecturer_id IN (
           SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
         )
       )`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM attendance_sessions
       WHERE started_by_lecturer_id IN (
         SELECT id FROM lecturers WHERE user_id = ANY($1::BIGINT[])
       )`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM audit_logs WHERE user_id = ANY($1::BIGINT[])`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM course_offering_lecturers
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (SELECT id FROM courses WHERE course_code = $1)
       )`,
      [E2E_COURSE_CODE]
    );
    await pool.query(
      `DELETE FROM course_registrations
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (SELECT id FROM courses WHERE course_code = $1)
       )`,
      [E2E_COURSE_CODE]
    );
    await pool.query(
      `DELETE FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code = $1)`,
      [E2E_COURSE_CODE]
    );
    await pool.query(`DELETE FROM courses WHERE course_code = $1`, [E2E_COURSE_CODE]);
    await pool.query(`DELETE FROM academic_sessions WHERE name = $1`, [
      E2E_ACADEMIC_SESSION_NAME,
    ]);
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  }

  await pool.query(`DELETE FROM attendance_networks WHERE network_code = $1`, [
    E2E_NETWORK_CODE,
  ]);
  await pool.query(`DELETE FROM locations WHERE name = $1`, [E2E_LOCATION_NAME]);
  await pool.query(`DELETE FROM departments WHERE code = $1`, [E2E_DEPARTMENT_CODE]);
  await pool.query(`DELETE FROM faculties WHERE code = $1`, [E2E_FACULTY_CODE]);
}

async function seed(): Promise<void> {
  await cleanup();

  await pool.query(
    `INSERT INTO faculties (name, code)
     VALUES ('E2E Test Faculty', $1)
     ON CONFLICT (code) DO NOTHING`,
    [E2E_FACULTY_CODE]
  );
  const facultyRes = await pool.query(
    `SELECT id FROM faculties WHERE code = $1`,
    [E2E_FACULTY_CODE]
  );
  const facultyId = Number(facultyRes.rows[0].id);

  const department = await pool.query(
    `INSERT INTO departments (name, code, faculty_id)
     VALUES ('E2E Test Department', $1, $2)
     RETURNING id`,
    [E2E_DEPARTMENT_CODE, facultyId]
  );
  const departmentId = Number(department.rows[0].id);

  const levels = await pool.query(`SELECT id FROM levels WHERE name = 100`);
  if (levels.rowCount === 0) {
    throw new Error("Level 100 not found. Run `npm run migrate` first.");
  }
  const levelId = Number(levels.rows[0].id);

  const passwordHash = await hashPassword(E2E_PASSWORD);

  const lecturerProfileIds = new Map<string, number>();

  for (const user of E2E_USERS) {
    const inserted = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, 'ACTIVE', $4)
       RETURNING id`,
      [user.name, passwordHash, user.role, user.username]
    );
    const userId = Number(inserted.rows[0].id);

    if (user.role === "STUDENT" && user.matricNumber !== null) {
      await pool.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, user.matricNumber, departmentId, levelId]
      );
    } else if (user.role === "LECTURER" && user.staffId !== null) {
      const lecturer = await pool.query(
        `INSERT INTO lecturers (user_id, staff_id, department_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, user.staffId, departmentId]
      );
      lecturerProfileIds.set(user.staffId, Number(lecturer.rows[0].id));
    }
  }

  const lecturerProfileId = lecturerProfileIds.get(E2E_LECTURER_STAFF_ID);
  const monitorLecturerProfileId = lecturerProfileIds.get(
    E2E_MONITOR_LECTURER_STAFF_ID
  );
  if (lecturerProfileId === undefined || monitorLecturerProfileId === undefined) {
    throw new Error("E2E lecturer profiles were not created.");
  }

  await pool.query(
    `INSERT INTO attendance_networks (network_code, name)
     VALUES ($1, $2)
     ON CONFLICT (network_code) DO NOTHING`,
    [E2E_NETWORK_CODE, E2E_NETWORK_NAME]
  );
  const networkId = Number(
    (
      await pool.query(
        `SELECT id FROM attendance_networks WHERE network_code = $1`,
        [E2E_NETWORK_CODE]
      )
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO locations (name)
     VALUES ($1)`,
    [E2E_LOCATION_NAME]
  );
  const locationId = Number(
    (
      await pool.query(`SELECT id FROM locations WHERE name = $1`, [
        E2E_LOCATION_NAME,
      ])
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO academic_sessions (name, is_active)
     VALUES ($1, true)
     ON CONFLICT (name) DO NOTHING`,
    [E2E_ACADEMIC_SESSION_NAME]
  );
  const academicSessionId = Number(
    (
      await pool.query(`SELECT id FROM academic_sessions WHERE name = $1`, [
        E2E_ACADEMIC_SESSION_NAME,
      ])
    ).rows[0].id
  );

  const semesters = await pool.query(
    `SELECT id, name FROM semesters WHERE name IN ('First Semester', 'Second Semester')`
  );
  const semesterIds = new Map<string, number>();
  for (const semester of semesters.rows) {
    semesterIds.set(String(semester.name), Number(semester.id));
  }
  const firstSemesterId = semesterIds.get("First Semester");
  const secondSemesterId = semesterIds.get("Second Semester");
  if (firstSemesterId === undefined || secondSemesterId === undefined) {
    throw new Error("Expected semesters were not found. Run `npm run migrate` first.");
  }

  await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (course_code) DO NOTHING`,
    [E2E_COURSE_CODE, E2E_COURSE_TITLE, departmentId, levelId]
  );
  const courseId = Number(
    (
      await pool.query(`SELECT id FROM courses WHERE course_code = $1`, [
        E2E_COURSE_CODE,
      ])
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (course_id, academic_session_id, semester_id) DO NOTHING`,
    [courseId, academicSessionId, firstSemesterId]
  );
  const openOfferingId = Number(
    (
      await pool.query(
        `SELECT id FROM course_offerings
         WHERE course_id = $1 AND academic_session_id = $2 AND semester_id = $3`,
        [courseId, academicSessionId, firstSemesterId]
      )
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id, status)
     VALUES ($1, $2, $3, 'CLOSED')
     ON CONFLICT (course_id, academic_session_id, semester_id) DO NOTHING`,
    [courseId, academicSessionId, secondSemesterId]
  );
  const closedOfferingId = Number(
    (
      await pool.query(
        `SELECT id FROM course_offerings
         WHERE course_id = $1 AND academic_session_id = $2 AND semester_id = $3`,
        [courseId, academicSessionId, secondSemesterId]
      )
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [openOfferingId, lecturerProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [closedOfferingId, lecturerProfileId]
  );
  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [openOfferingId, monitorLecturerProfileId]
  );

  await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, created_at)
     VALUES
       ($1, $2, $3, $4,
        now() - interval '30 minutes', now() + interval '30 minutes',
        interval '5 minutes', 'ACTIVE', now() - interval '30 minutes')`,
    [openOfferingId, monitorLecturerProfileId, networkId, locationId]
  );
  await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id, attendance_network_id,
        location_id, start_time, end_time, late_threshold, status, created_at, ended_at)
     VALUES
       ($1, $2, $3, $4,
        now() - interval '2 days', now() - interval '2 days' + interval '60 minutes',
        interval '5 minutes', 'ENDED', now() - interval '2 days',
        now() - interval '2 days' + interval '60 minutes')`,
    [openOfferingId, monitorLecturerProfileId, networkId, locationId]
  );

  console.log("Seeded E2E authentication users.");
}

async function main(): Promise<void> {
  const cleanupOnly = process.argv.includes("--cleanup");

  try {
    if (cleanupOnly) {
      await cleanup();
      console.log("Removed E2E authentication users.");
    } else {
      await seed();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Failed to seed E2E authentication users:", (error as Error).message);
  process.exit(1);
});