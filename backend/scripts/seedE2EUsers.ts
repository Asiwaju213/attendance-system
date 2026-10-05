import { pool } from "../src/db/pool";
import { appendLecturerEvent } from "../src/services/syncMasterDataEmitters";
import { getTestDatabaseName } from "../src/config/testDatabase";
import { hashPassword } from "../src/lib/passwords";

export const E2E_PASSWORD = "auth-flow-test-password";

const E2E_DEPARTMENT_CODE = "E2EFLOW";
const E2E_FACULTY_CODE = "E2EFAC";

const E2E_STUDENT_MATRIC = "E2E/STU/0001";
const E2E_LECTURER_STAFF_ID = "E2E/LEC/0001";
const E2E_MONITOR_LECTURER_STAFF_ID = "E2E/LEC/0002";
const E2E_STUDENT_MARK_LECTURER_STAFF_ID = "E2E/LEC/0003";
const E2E_ADMIN_USERNAME = "e2e_admin";

const E2E_ACADEMIC_SESSION_NAME = "E2E-2026/2027";
const E2E_COURSE_CODE = "E2E-101";
const E2E_COURSE_TITLE = "E2E Computer Science 101";
const E2E_COURSE_CODE_TWO = "E2E-102";
const E2E_COURSE_TITLE_TWO = "E2E Computer Science 102";
const E2E_COURSE_CODE_THREE = "E2E-103";
const E2E_COURSE_TITLE_THREE = "E2E Computer Science 103";

const E2E_STUDENT_MATRICS = [
  "E2E/STU/0001",
  "E2E/STU/0002",
  "E2E/STU/0003",
] as const;

const E2E_STUDENT_PENDING_MATRIC = "E2E/STU/0004";
const E2E_STUDENT_NO_COURSES_MATRIC = "E2E/STU/0005";

// Dedicated students for the admin student-management spec. They are kept out
// of E2E_STUDENT_MATRICS so no E2E course is auto-enrolled for them, and their
// status is mutated by the admin-student-management tests without disturbing
// the shared E2E students used by the parallel E2E specs.
const E2E_STUDENT_ACTIVE_MANAGEMENT_MATRIC = "E2E/STU/0010";
const E2E_STUDENT_INACTIVE_MANAGEMENT_MATRIC = "E2E/STU/0011";
const E2E_STUDENT_PENDING_MANAGEMENT_MATRIC = "E2E/STU/0012";
const E2E_STUDENT_RESET_MANAGEMENT_MATRIC = "E2E/STU/0013";

// Status overrides for E2E student users. Everything defaults to ACTIVE.
const STUDENT_SEED_STATUSES: Record<string, "ACTIVE" | "INACTIVE" | "PENDING"> = {
  [E2E_STUDENT_PENDING_MATRIC]: "PENDING",
  [E2E_STUDENT_INACTIVE_MANAGEMENT_MATRIC]: "INACTIVE",
  [E2E_STUDENT_PENDING_MANAGEMENT_MATRIC]: "PENDING",
};

// Matric numbers the admin student-import spec creates through the import flow
// itself (they are never seeded directly). Keeping them in the cleanup list
// lets the next seed run remove any rows a previous run left behind, including
// after a failed import test.
const E2E_IMPORT_MATRICS = [
  "E2E/IMP/0001",
  "E2E/IMP/0002",
  "E2E/IMP/0003",
  "E2E/IMP/0501",
  "E2E/IMP/0502",
  "E2E/IMP/0503",
] as const;

const E2E_COURSE_CODES = [
  E2E_COURSE_CODE,
  E2E_COURSE_CODE_TWO,
  E2E_COURSE_CODE_THREE,
] as const;

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
    name: "E2E Student Two",
    role: "STUDENT",
    username: null,
    matricNumber: "E2E/STU/0002",
    staffId: null,
  },
  {
    name: "E2E Student Three",
    role: "STUDENT",
    username: null,
    matricNumber: "E2E/STU/0003",
    staffId: null,
  },
  {
    name: "E2E Student Pending",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_PENDING_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Student No Courses",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_NO_COURSES_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Active Management",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_ACTIVE_MANAGEMENT_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Inactive Management",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_INACTIVE_MANAGEMENT_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Pending Management",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_PENDING_MANAGEMENT_MATRIC,
    staffId: null,
  },
  {
    name: "E2E Reset Management",
    role: "STUDENT",
    username: null,
    matricNumber: E2E_STUDENT_RESET_MANAGEMENT_MATRIC,
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
    name: "E2E Student Mark Lecturer",
    role: "LECTURER",
    username: null,
    matricNumber: null,
    staffId: E2E_STUDENT_MARK_LECTURER_STAFF_ID,
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
      WHERE s.matric_number = ANY($1::TEXT[])
         OR l.staff_id = ANY($2::TEXT[])
         OR u.username = $3`,
    [
      [
        ...E2E_STUDENT_MATRICS,
        E2E_STUDENT_PENDING_MATRIC,
        E2E_STUDENT_NO_COURSES_MATRIC,
        E2E_STUDENT_ACTIVE_MANAGEMENT_MATRIC,
        E2E_STUDENT_INACTIVE_MANAGEMENT_MATRIC,
        E2E_STUDENT_PENDING_MANAGEMENT_MATRIC,
        E2E_STUDENT_RESET_MANAGEMENT_MATRIC,
        ...E2E_IMPORT_MATRICS,
      ],
      [
        E2E_LECTURER_STAFF_ID,
        E2E_MONITOR_LECTURER_STAFF_ID,
        E2E_STUDENT_MARK_LECTURER_STAFF_ID,
      ],
      E2E_ADMIN_USERNAME,
    ]
  );
  return result.rows.map((row) => Number(row.id));
}

async function assertTestDatabaseIdentity(): Promise<void> {
  const expectedDatabaseName = getTestDatabaseName();
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.DATABASE_NAME !== expectedDatabaseName
  ) {
    throw new Error(
      `Refusing E2E seed/cleanup: expected test database "${expectedDatabaseName}".`
    );
  }

  const identity = await pool.query(
    "SELECT current_database() AS database_name"
  );
  const actualDatabaseName = identity.rows[0]?.database_name;
  if (actualDatabaseName !== expectedDatabaseName) {
    throw new Error(
      `Refusing E2E seed/cleanup: connected to "${actualDatabaseName}".`
    );
  }
}

async function resetCourseRegistrations(courseCode: string): Promise<number> {
  await assertTestDatabaseIdentity();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM audit_logs
       WHERE entity_type = 'course_registrations'
         AND entity_id IN (
           SELECT id FROM course_registrations
           WHERE course_offering_id IN (
             SELECT id FROM course_offerings
             WHERE course_id IN (
               SELECT id FROM courses WHERE course_code = $1
             )
           )
         )`,
      [courseCode]
    );
    const result = await client.query(
      `DELETE FROM course_registrations
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (
           SELECT id FROM courses WHERE course_code = $1
         )
       )`,
      [courseCode]
    );
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await assertTestDatabaseIdentity();
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
      `DELETE FROM attendance_records
       WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))
         AND session_id NOT IN (
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
      `DELETE FROM student_device_enrollment_challenges
       WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM student_devices
       WHERE student_id IN (SELECT id FROM students WHERE user_id = ANY($1::BIGINT[]))`,
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
         WHERE course_id IN (SELECT id FROM courses WHERE course_code = ANY($1::TEXT[]))
       )`,
      [E2E_COURSE_CODES]
    );
    await pool.query(
      `DELETE FROM course_registrations
       WHERE course_offering_id IN (
         SELECT id FROM course_offerings
         WHERE course_id IN (SELECT id FROM courses WHERE course_code = ANY($1::TEXT[]))
       )`,
      [E2E_COURSE_CODES]
    );
    await pool.query(
      `DELETE FROM course_offerings
       WHERE course_id IN (SELECT id FROM courses WHERE course_code = ANY($1::TEXT[]))`,
      [E2E_COURSE_CODES]
    );
    await pool.query(
      `DELETE FROM courses WHERE course_code = ANY($1::TEXT[])`,
      [E2E_COURSE_CODES]
    );
    await pool.query(`DELETE FROM academic_sessions WHERE name = $1`, [
      E2E_ACADEMIC_SESSION_NAME,
    ]);
    await pool.query(
      `DELETE FROM student_registration_challenges WHERE user_id = ANY($1::BIGINT[])`,
      [userIds]
    );
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  }

  await pool.query(
    `DELETE FROM student_import_previews
     WHERE department_id = (SELECT id FROM departments WHERE code = $1)`,
    [E2E_DEPARTMENT_CODE]
  );
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

  const level300 = await pool.query(`SELECT id FROM levels WHERE name = 300`);
  if (level300.rowCount === 0) {
    throw new Error("Level 300 not found. Run `npm run migrate` first.");
  }
  const level300Id = Number(level300.rows[0].id);

  const passwordHash = await hashPassword(E2E_PASSWORD);

  const lecturerProfileIds = new Map<string, number>();
  const studentProfileIds = new Map<string, number>();

  for (const user of E2E_USERS) {
    const studentSeedStatus =
      user.role === "STUDENT" && user.matricNumber !== null
        ? (STUDENT_SEED_STATUSES[user.matricNumber] ?? "ACTIVE")
        : "ACTIVE";
    const isPendingStudent = studentSeedStatus === "PENDING";
    const inserted = await pool.query(
      `INSERT INTO users (name, password_hash, role, status, username)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        user.name,
        isPendingStudent ? null : passwordHash,
        user.role,
        isPendingStudent ? "PENDING" : studentSeedStatus,
        user.username,
      ]
    );
    const userId = Number(inserted.rows[0].id);

    if (user.role === "STUDENT" && user.matricNumber !== null) {
      const studentLevelId =
        user.matricNumber === E2E_STUDENT_NO_COURSES_MATRIC
          ? level300Id
          : levelId;
      const student = await pool.query(
        `INSERT INTO students (user_id, matric_number, department_id, level_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, user.matricNumber, departmentId, studentLevelId]
      );
      studentProfileIds.set(user.matricNumber, Number(student.rows[0].id));
    } else if (user.role === "LECTURER" && user.staffId !== null) {
      // Lecturer profiles have no runtime creation path in the application, so
      // this seeder is the only place they come into existence. Emitting the
      // change event here keeps `sync_lecturers` populated on a seeded database
      // and exercises the same transactional path a future provisioning endpoint
      // would use.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lecturer = await client.query(
          `INSERT INTO lecturers (user_id, staff_id, department_id)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, user.staffId, departmentId]
        );
        const lecturerId = Number(lecturer.rows[0].id);
        await appendLecturerEvent(client, "CREATED", lecturerId);
        await client.query("COMMIT");
        lecturerProfileIds.set(user.staffId, lecturerId);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  }

  const lecturerProfileId = lecturerProfileIds.get(E2E_LECTURER_STAFF_ID);
  const monitorLecturerProfileId = lecturerProfileIds.get(
    E2E_MONITOR_LECTURER_STAFF_ID
  );
  const studentMarkLecturerProfileId = lecturerProfileIds.get(
    E2E_STUDENT_MARK_LECTURER_STAFF_ID
  );
  if (
    lecturerProfileId === undefined ||
    monitorLecturerProfileId === undefined ||
    studentMarkLecturerProfileId === undefined
  ) {
    throw new Error("E2E lecturer profiles were not created.");
  }

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
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [openOfferingId, studentMarkLecturerProfileId]
  );

  // A second, open course offering assigned only to the monitor lecturer. It
  // has no registrations or sessions, and gives the lecturer reports spec a
  // cross-lecturer isolation pair: only the monitor lecturer's selector should
  // ever list it, and E2E/LEC/0001 must get OFFERING_NOT_FOUND for it.
  await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (course_code) DO NOTHING`,
    [E2E_COURSE_CODE_TWO, E2E_COURSE_TITLE_TWO, departmentId, levelId]
  );
  const courseTwoId = Number(
    (
      await pool.query(`SELECT id FROM courses WHERE course_code = $1`, [
        E2E_COURSE_CODE_TWO,
      ])
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (course_id, academic_session_id, semester_id) DO NOTHING`,
    [courseTwoId, academicSessionId, firstSemesterId]
  );
  const openOfferingTwoId = Number(
    (
      await pool.query(
        `SELECT id FROM course_offerings
         WHERE course_id = $1 AND academic_session_id = $2 AND semester_id = $3`,
        [courseTwoId, academicSessionId, firstSemesterId]
      )
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [openOfferingTwoId, monitorLecturerProfileId]
  );

  const studentProfileId = studentProfileIds.get(E2E_STUDENT_MATRIC);
  if (studentProfileId === undefined) {
    throw new Error("E2E student profile was not created.");
  }
  await pool.query(
    `INSERT INTO course_registrations (student_id, course_offering_id, status)
     VALUES ($1, $2, 'ENROLLED')
     ON CONFLICT (student_id, course_offering_id) DO NOTHING`,
    [studentProfileId, openOfferingId]
  );

  // A third, open course offering assigned only to the main lecturer, with
  // three enrolled students and one ENDED session that shows PRESENT, LATE and
  // ABSENT together. The lecturer session-attendance-report spec reads this
  // session through the main lecturer's own session list, and every assertion
  // in the admin monitoring/report specs stays valid because none of this
  // offering's data touches E2E-101 (its roster and completed-session counts
  // are unchanged) and none of its sessions are started by the monitor.
  await pool.query(
    `INSERT INTO courses (course_code, title, department_id, level_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (course_code) DO NOTHING`,
    [E2E_COURSE_CODE_THREE, E2E_COURSE_TITLE_THREE, departmentId, levelId]
  );
  const courseThreeId = Number(
    (
      await pool.query(`SELECT id FROM courses WHERE course_code = $1`, [
        E2E_COURSE_CODE_THREE,
      ])
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offerings (course_id, academic_session_id, semester_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (course_id, academic_session_id, semester_id) DO NOTHING`,
    [courseThreeId, academicSessionId, firstSemesterId]
  );
  const openOfferingThreeId = Number(
    (
      await pool.query(
        `SELECT id FROM course_offerings
         WHERE course_id = $1 AND academic_session_id = $2 AND semester_id = $3`,
        [courseThreeId, academicSessionId, firstSemesterId]
      )
    ).rows[0].id
  );

  await pool.query(
    `INSERT INTO course_offering_lecturers (course_offering_id, lecturer_id)
     VALUES ($1, $2)
     ON CONFLICT (course_offering_id, lecturer_id) DO NOTHING`,
    [openOfferingThreeId, lecturerProfileId]
  );

  for (const matric of E2E_STUDENT_MATRICS) {
    const studentId = studentProfileIds.get(matric);
    if (studentId === undefined) {
      throw new Error(`E2E student profile for ${matric} was not created.`);
    }
    await pool.query(
      `INSERT INTO course_registrations (student_id, course_offering_id, status)
       VALUES ($1, $2, 'ENROLLED')
       ON CONFLICT (student_id, course_offering_id) DO NOTHING`,
      [studentId, openOfferingThreeId]
    );
  }

  const sessionThreeRes = await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id,
        start_time, end_time, late_threshold, status, created_at, ended_at)
     VALUES
       ($1, $2,
        now() - interval '3 days', now() - interval '3 days' + interval '60 minutes',
        interval '5 minutes', 'ENDED', now() - interval '3 days',
        now() - interval '3 days' + interval '60 minutes')
     RETURNING id`,
    [openOfferingThreeId, lecturerProfileId]
  );
  const sessionThreeId = Number(sessionThreeRes.rows[0].id);

  const presentStudentId = studentProfileIds.get(E2E_STUDENT_MATRIC);
  const lateStudentId = studentProfileIds.get("E2E/STU/0002");
  if (presentStudentId === undefined || lateStudentId === undefined) {
    throw new Error("E2E student profiles for the session report were not created.");
  }
  // E2E/STU/0001 PRESENT, E2E/STU/0002 LATE; E2E/STU/0003 has no record and
  // therefore reads as ABSENT in the report.
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
     VALUES ($1, $2, 'PRESENT', now() - interval '3 days' + interval '10 minutes'),
            ($3, $4, 'LATE', now() - interval '3 days' + interval '25 minutes')
     ON CONFLICT (session_id, student_id) DO NOTHING`,
    [sessionThreeId, presentStudentId, sessionThreeId, lateStudentId]
  );

  await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id,
        start_time, end_time, late_threshold, status, created_at)
     VALUES
       ($1, $2,
        now() - interval '30 minutes', now() + interval '30 minutes',
        interval '5 minutes', 'ACTIVE', now() - interval '30 minutes')`,
    [openOfferingId, monitorLecturerProfileId]
  );
  await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id,
        start_time, end_time, late_threshold, status, created_at, ended_at)
     VALUES
       ($1, $2,
        now() - interval '2 days', now() - interval '2 days' + interval '60 minutes',
        interval '5 minutes', 'ENDED', now() - interval '2 days',
        now() - interval '2 days' + interval '60 minutes')`,
    [openOfferingId, monitorLecturerProfileId]
  );
  // An ACTIVE session for the student-marking tests, intentionally left
  // unmarked so the student spec sees an eligible session with a mark action.
  // A separate lecturer is used so the admin monitoring fixtures (exactly two
  // sessions/records for the monitor lecturer) and the lecturer attendance
  // fixtures (E2E/LEC/0001 starts its own sessions) stay independent.
  await pool.query(
    `INSERT INTO attendance_sessions
       (course_offering_id, started_by_lecturer_id,
        start_time, end_time, late_threshold, status, created_at)
     VALUES
       ($1, $2,
        now() - interval '30 minutes', now() + interval '30 minutes',
        interval '5 minutes', 'ACTIVE', now() - interval '30 minutes')`,
    [openOfferingId, studentMarkLecturerProfileId]
  );

  // Seed attendance records for the E2E student in both monitor sessions
  const sessionRes = await pool.query(
    `SELECT id FROM attendance_sessions
     WHERE course_offering_id = $1 AND started_by_lecturer_id = $2
     ORDER BY start_time`,
    [openOfferingId, monitorLecturerProfileId]
  );
  const sessionIds = sessionRes.rows.map((r) => Number(r.id));
  if (sessionIds.length >= 2) {
    // First session: PRESENT
    await pool.query(
      `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
       VALUES ($1, $2, 'PRESENT', now() - interval '15 minutes')
       ON CONFLICT (session_id, student_id) DO NOTHING`,
      [sessionIds[0], studentProfileId]
    );
    // Second session: LATE
    await pool.query(
      `INSERT INTO attendance_records (session_id, student_id, status, marked_at)
       VALUES ($1, $2, 'LATE', now() - interval '1 day')
       ON CONFLICT (session_id, student_id) DO NOTHING`,
      [sessionIds[1], studentProfileId]
    );
  }

  console.log("Seeded E2E authentication users.");
}

async function main(): Promise<void> {
  const cleanupOnly = process.argv.includes("--cleanup");
  const resetPrefix = "--reset-course-registrations=";
  const resetArgument = process.argv.find((argument) =>
    argument.startsWith(resetPrefix)
  );
  const resetCourseCode = resetArgument?.slice(resetPrefix.length);

  if (cleanupOnly && resetCourseCode) {
    throw new Error("Choose either E2E cleanup or a course-registration reset.");
  }
  if (
    resetCourseCode &&
    !E2E_COURSE_CODES.some((courseCode) => courseCode === resetCourseCode)
  ) {
    throw new Error(`Refusing to reset non-E2E course: "${resetCourseCode}".`);
  }

  try {
    if (resetCourseCode) {
      const removed = await resetCourseRegistrations(resetCourseCode);
      console.log(
        `Reset ${removed} course registration(s) for ${resetCourseCode}.`
      );
    } else if (cleanupOnly) {
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