import { pool } from "../src/db/pool";
import { readFileSync, existsSync } from "node:fs";

(async () => {
  console.log("=== sync_consumer_state ===");
  let r = await pool.query(
    "SELECT consumer_id, last_cursor FROM sync_consumer_state"
  );
  for (const row of r.rows)
    console.log(row.consumer_id + ": cursor=" + row.last_cursor);

  console.log("\n=== sync_processed_events ===");
  r = await pool.query(
    "SELECT consumer_id, count(*)::int AS n FROM sync_processed_events GROUP BY consumer_id"
  );
  for (const row of r.rows)
    console.log(row.consumer_id + ": " + row.n + " events");

  console.log("\n=== student users (no password hash) ===");
  r = await pool.query(
    "SELECT id, name, role, status, (password_hash IS NOT NULL) AS has_hash FROM users WHERE role = 'STUDENT' ORDER BY id"
  );
  for (const row of r.rows)
    console.log(
      "user_id=" +
        row.id +
        " name=" +
        row.name +
        " status=" +
        row.status +
        " has_hash=" +
        row.has_hash
    );

  console.log("\n=== students ===");
  r = await pool.query(
    "SELECT id, user_id, matric_number, department_id, level_id FROM students ORDER BY id"
  );
  for (const row of r.rows)
    console.log(
      "student_id=" +
        row.id +
        " user_id=" +
        row.user_id +
        " matric=" +
        row.matric_number
    );

  console.log("\n=== sync_student_devices ===");
  r = await pool.query(
    "SELECT cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status FROM sync_student_devices"
  );
  for (const row of r.rows)
    console.log(
      "cloud_sync_id=" +
        row.cloud_sync_id +
        " status=" +
        row.status +
        " student_id=" +
        row.student_id +
        " cloud_student_sync_id=" +
        row.cloud_student_sync_id
    );

  console.log("\n=== sync_student_device_bootstraps ===");
  r = await pool.query(
    "SELECT cloud_sync_id, cloud_device_ref, student_id, cloud_student_sync_id, status, expires_at, (consumed_at IS NOT NULL) AS consumed FROM sync_student_device_bootstraps"
  );
  for (const row of r.rows)
    console.log(
      "cloud_sync_id=" +
        row.cloud_sync_id +
        " status=" +
        row.status +
        " student_id=" +
        row.student_id +
        " expires=" +
        row.expires_at +
        " consumed=" +
        row.consumed
    );

  console.log("\n=== cloud_feed_snapshot (before recovery) ===");
  const snapPath =
    "C:\\Users\\kalej\\AppData\\Local\\Temp\\opencode\\cloud_feed_snapshot_before_recovery.json";
  if (existsSync(snapPath)) {
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    const events = snap.events || snap;
    console.log("Total events in snapshot: " + events.length);
    for (const e of events) {
      const p = e.payload || e;
      const entity = p.entity || p.session || p;
      console.log(
        "cursor=" +
          e.cursor +
          " entity=" +
          e.entity_type +
          " op=" +
          e.operation +
          " entity_id=" +
          e.entity_id +
          " keys=" +
          Object.keys(entity).join(",")
      );
    }
  } else {
    console.log("Snapshot file not found");
  }

  await pool.end();
})();
