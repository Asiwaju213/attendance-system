import { join } from "node:path";
import dotenv from "dotenv";
import { pool } from "../src/db/pool";

dotenv.config({
  path: join(__dirname, "..", ".env"),
  override: false,
  quiet: true,
});

const TARGET_SYNC_ID = "9e5110ce-c91f-4fd4-bc36-7ef625168f4a";

type StudentRow = {
  id: number;
  sync_id: string;
  matric_number: string | null;
  department_id: number | null;
  level_id: number | null;
  status: string | null;
  created_at: string;
  updated_at: string;
};

type StudentEventRow = {
  event_id: string;
  cursor: number;
  operation: string;
  recorded_at: string;
};

async function main(): Promise<void> {
  console.log(`Checking Cloud student feed state for sync_id=${TARGET_SYNC_ID}`);

  const studentResult = await pool.query<StudentRow>(
    `
      SELECT
        s.id,
        s.sync_id,
        s.matric_number,
        s.department_id,
        s.level_id,
        u.status,
        s.created_at,
        s.updated_at
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.sync_id = $1
      ORDER BY s.id ASC
    `,
    [TARGET_SYNC_ID]
  );

  const studentCount = studentResult.rowCount ?? 0;
  console.log(`Student rows found: ${studentCount}`);

  if (studentCount === 0) {
    console.log("No student row found for the target sync_id.");
    console.log("CLASSIFICATION: DO_NOT_REPUBLISH");
    return;
  }

  const student = studentResult.rows[0];

  console.log("Student details:");
  console.log(`  student_id: ${Number(student.id)}`);
  console.log(`  sync_id: ${String(student.sync_id)}`);
  console.log(`  matric_number: ${student.matric_number ?? "<null>"}`);
  console.log(`  department_id: ${student.department_id ?? "<null>"}`);
  console.log(`  level_id: ${student.level_id ?? "<null>"}`);
  console.log(`  user_status: ${student.status ?? "<null>"}`);
  console.log(`  created_at: ${student.created_at}`);
  console.log(`  updated_at: ${student.updated_at}`);

  const existingStudentEvents = await pool.query<StudentEventRow>(
    `
      SELECT
        event_id,
        cursor,
        operation,
        recorded_at
      FROM sync_change_events
      WHERE entity_type = 'student'
        AND entity_id = $1
      ORDER BY cursor ASC
    `,
    [TARGET_SYNC_ID]
  );

  const totalStudentEvents = existingStudentEvents.rowCount ?? 0;
  console.log(`Existing student feed events total: ${totalStudentEvents}`);

  if (totalStudentEvents === 0) {
    console.log("No existing student change events for this entity.");
  } else {
    console.log("Existing student feed events:");
    for (const event of existingStudentEvents.rows) {
      console.log(
        `  event_id=${event.event_id}, cursor=${Number(event.cursor)}, operation=${event.operation}, recorded_at=${event.recorded_at}`
      );
    }
  }

  const exactStudentCount = studentCount === 1;
  const syncIdMatches = String(student.sync_id) === TARGET_SYNC_ID;
  const zeroStudentEvents = totalStudentEvents === 0;
  const safeToRepublish = exactStudentCount && syncIdMatches && zeroStudentEvents;

  console.log(
    `CLASSIFICATION: ${safeToRepublish ? "SAFE_TO_REPUBLISH" : "DO_NOT_REPUBLISH"}`
  );

  if (!safeToRepublish) {
    if (!exactStudentCount) {
      console.log("Reason: student row count is not exactly one.");
    }
    if (!syncIdMatches) {
      console.log("Reason: returned sync_id does not exactly match the target sync_id.");
    }
    if (!zeroStudentEvents) {
      console.log("Reason: one or more student feed events already exist.");
    }
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("Check failed.");
    if (error instanceof Error) {
      console.error(error.message);
      if (error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
