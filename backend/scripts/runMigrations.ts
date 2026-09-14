import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";
import { dbConfig } from "../src/config/env";

const MIGRATIONS_DIR = join(__dirname, "../../database/migrations");

async function main() {
  const client = new Client(dbConfig);
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         BIGSERIAL   PRIMARY KEY,
        filename   TEXT        NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(result.rows.map((row) => row.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log("No new migrations to apply.");
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file}...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied ${file}.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", (error as Error).message);
  process.exit(1);
});