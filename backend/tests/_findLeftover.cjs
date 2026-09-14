const { pool } = require("./src/db/pool");
(async () => {
  const r = await pool.query(`SELECT s.id, s.user_id, s.matric_number, u.name FROM students s LEFT JOIN users u ON u.id = s.user_id JOIN departments d ON d.id = s.department_id WHERE d.code = 'DEVDEP'`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
})();
