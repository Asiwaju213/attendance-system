import { pool } from "./src/db/pool";

async function main(): Promise<void> {
  const patterns = [
    { nameLike: "Satt %", nameLikeUpper: "SATT %", username: "satt_admin" },
    { nameLike: "Mark %", nameLikeUpper: "MARK %", username: "mark_admin" },
    { nameLike: "Regc %", nameLikeUpper: "REGC %", username: "regc_admin" },
    { nameLike: "Regst %", nameLikeUpper: "REGST %", username: "regst_admin" },
  ];
  for (const p of patterns) {
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (
         SELECT id FROM users
         WHERE username = $1 OR name LIKE $2 OR name LIKE $3
       )`,
      [p.username, p.nameLike, p.nameLikeUpper]
    );
    const users = await pool.query(
      `DELETE FROM users WHERE username = $1 OR name LIKE $2 OR name LIKE $3 RETURNING id`,
      [p.username, p.nameLike, p.nameLikeUpper]
    );
    console.log(`cleaned ${p.username}: removed ${users.rowCount} users`);
    await pool.query(`DELETE FROM courses WHERE course_code LIKE $1`, [
      p.nameLike.replace(" %", "%").toUpperCase().replace(" %", "%").slice(0, 4) + "%",
    ]);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});