import { Client } from "pg";
import { dbConfig, databaseSource } from "./src/config/env";

const TABLES = [
  "users",
  "students",
  "student_registration_challenges",
  "student_device_enrollment_challenges",
  "student_device_enrollment_grants",
  "student_devices",
  "audit_logs",
];

async function main(): Promise<void> {
  const client = new Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
  });
  await client.connect();

  console.log("--- target ---");
  console.log(
    JSON.stringify({
      source: databaseSource,
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
    })
  );

  console.log("--- schema_migrations ---");
  const mig = await client.query(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`
  );
  console.log("applied:", mig.rowCount);
  for (const row of mig.rows) {
    console.log(`  ${row.filename} @ ${row.applied_at}`);
  }

  console.log("--- all tables present in public schema ---");
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  console.log(tables.rows.map((r) => r.table_name).join(", "));

  for (const table of TABLES) {
    console.log(`--- columns: ${table} ---`);
    try {
      const cols = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default,
                (is_nullable = 'NO') AS not_null
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [table]
      );
      if (cols.rowCount === 0) {
        console.log("  !!! TABLE DOES NOT EXIST !!!");
        continue;
      }
      console.log(
        JSON.stringify(
          cols.rows.map((r) => ({
            col: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable,
          })),
          null,
          1
        )
      );
    } catch (error) {
      console.log("  ERROR:", (error as Error).message);
    }
  }

  console.log("--- constraints on users ---");
  const cons = await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'public.users'::regclass AND contype IN ('c', 'c ')
      ORDER BY conname`
  );
  console.log(JSON.stringify(cons.rows, null, 1));

  console.log("--- triggers on the involved tables ---");
  const trg = await client.query(
    `SELECT event_object_table, trigger_name, action_statement
       FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = ANY($1::text[])
      ORDER BY event_object_table, trigger_name`,
    [TABLES]
  );
  console.log(JSON.stringify(trg.rows, null, 1));

  await client.end();
}

main().catch((error) => {
  console.error("PROBE FAILED:", (error as Error).message);
  process.exitCode = 1;
});
