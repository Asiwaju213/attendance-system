import { pool } from "../src/db/pool";
import { hashPassword } from "../src/lib/passwords";

export const E2E_PASSWORD = "auth-flow-test-password";

const E2E_DEPARTMENT_CODE = "E2EFLOW";
const E2E_FACULTY_CODE = "E2EFAC";

const E2E_STUDENT_MATRIC = "E2E/STU/0001";
const E2E_LECTURER_STAFF_ID = "E2E/LEC/0001";
const E2E_ADMIN_USERNAME = "e2e_admin";

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
         OR l.staff_id = $2
         OR u.username = $3`,
    [E2E_STUDENT_MATRIC, E2E_LECTURER_STAFF_ID, E2E_ADMIN_USERNAME]
  );
  return result.rows.map((row) => Number(row.id));
}

async function cleanup(): Promise<void> {
  const userIds = await findE2EUserIds();

  if (userIds.length > 0) {
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM students WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM lecturers WHERE user_id = ANY($1::BIGINT[])`, [userIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::BIGINT[])`, [userIds]);
  }

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
      await pool.query(
        `INSERT INTO lecturers (user_id, staff_id, department_id)
         VALUES ($1, $2, $3)`,
        [userId, user.staffId, departmentId]
      );
    }
  }

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