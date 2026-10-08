const { Client } = require('pg');
require('dotenv').config({ path: '.env' });

(async () => {
  const client = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME || process.env.DB_NAME || 'oou_attendance',
    user: process.env.DATABASE_USER || process.env.DB_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD,
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
  });

  try {
    await client.connect();
    await client.query('BEGIN');

    const idCheck = await client.query(
      'SELECT id, user_id, matric_number, sync_id, department_id, level_id FROM students WHERE id = $1 FOR UPDATE',
      [5194]
    );
    if (!idCheck.rowCount || idCheck.rowCount !== 1) {
      throw new Error('PRECHECK_FAIL: exact local student row 5194 missing or duplicated');
    }

    const row = idCheck.rows[0];
    if (String(row.user_id) !== '10470') throw new Error('PRECHECK_FAIL: user_id mismatch');
    if (String(row.matric_number) !== 'EES/23/24/0400') throw new Error('PRECHECK_FAIL: matric mismatch');
    if (String(row.sync_id) !== '109bd7e1-0994-46ed-b2f3-1bcca52d1c95') throw new Error('PRECHECK_FAIL: old sync_id mismatch');
    if (String(row.department_id) !== '2386') throw new Error('PRECHECK_FAIL: department_id mismatch');
    if (String(row.level_id) !== '4') throw new Error('PRECHECK_FAIL: level_id mismatch');

    const userRow = await client.query('SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE', [10470]);
    if (!userRow.rowCount) throw new Error('PRECHECK_FAIL: user 10470 missing');
    if (String(userRow.rows[0].role) !== 'STUDENT') throw new Error('PRECHECK_FAIL: user role mismatch');
    if (String(userRow.rows[0].status) !== 'ACTIVE') throw new Error('PRECHECK_FAIL: user status mismatch');

    const dept = await client.query('SELECT id, sync_id FROM departments WHERE id = $1 FOR UPDATE', [2386]);
    if (!dept.rowCount || String(dept.rows[0].sync_id) !== 'd2136f0c-b259-4486-bce4-1bd46706f92f') {
      throw new Error('PRECHECK_FAIL: department sync_id mismatch');
    }

    const lvl = await client.query('SELECT id, sync_id FROM levels WHERE id = $1 FOR UPDATE', [4]);
    if (!lvl.rowCount || String(lvl.rows[0].sync_id) !== 'ca4198a6-a36c-4bcf-aa5c-e29106c51765') {
      throw new Error('PRECHECK_FAIL: level sync_id mismatch');
    }

    const otherSync = await client.query(
      'SELECT id FROM students WHERE sync_id = $1 AND id != $2',
      ['9e5110ce-c91f-4fd4-bc36-7ef625168f4a', 5194]
    );
    if (otherSync.rowCount > 0) throw new Error('PRECHECK_FAIL: another local row already has cloud sync_id');

    const otherMatric = await client.query(
      'SELECT id FROM students WHERE matric_number = $1 AND id != $2',
      ['EES/23/24/0400', 5194]
    );
    if (otherMatric.rowCount > 0) throw new Error('PRECHECK_FAIL: another local row already has target matric');

    const consumer = await client.query(
      'SELECT consumer_id, last_cursor FROM sync_consumer_state WHERE consumer_id = $1 FOR UPDATE',
      ['oou-k12-main']
    );
    if (!consumer.rowCount) throw new Error('PRECHECK_FAIL: consumer state missing');
    if (String(consumer.rows[0].last_cursor) !== '23') throw new Error('PRECHECK_FAIL: consumer last_cursor mismatch');

    const processed = await client.query(
      'SELECT cursor FROM sync_processed_events WHERE consumer_id = $1 ORDER BY cursor ASC',
      ['oou-k12-main']
    );
    const cursors = processed.rows.map((r) => Number(r.cursor));
    const expected = Array.from({ length: 23 }, (_, i) => i + 1);
    const missing = expected.filter((v) => !cursors.includes(v));
    const forbidden = cursors.filter((v) => v >= 24 && v <= 26);
    if (missing.length || forbidden.length) {
      throw new Error('PRECHECK_FAIL: cursor receipt mismatch: ' + JSON.stringify({ expected, actual: cursors, missing, forbidden }));
    }

    const update = await client.query(
      `UPDATE students
       SET sync_id = $1
       WHERE id = $2
         AND user_id = $3
         AND matric_number = $4
         AND sync_id = $5`,
      [
        '9e5110ce-c91f-4fd4-bc36-7ef625168f4a',
        5194,
        10470,
        'EES/23/24/0400',
        '109bd7e1-0994-46ed-b2f3-1bcca52d1c95',
      ]
    );
    if (update.rowCount !== 1) throw new Error('WRITE_FAIL: update row count was not exactly 1');

    const post = await client.query(
      'SELECT id, user_id, matric_number, department_id, level_id, sync_id FROM students WHERE id = $1',
      [5194]
    );
    if (String(post.rows[0].sync_id) !== '9e5110ce-c91f-4fd4-bc36-7ef625168f4a') {
      throw new Error('POSTCHECK_FAIL: update did not set cloud sync_id');
    }

    const countCloudSync = await client.query(
      'SELECT COUNT(*)::int AS count FROM students WHERE sync_id = $1',
      ['9e5110ce-c91f-4fd4-bc36-7ef625168f4a']
    );
    if (Number(countCloudSync.rows[0].count) !== 1) throw new Error('POSTCHECK_FAIL: cloud sync_id not unique');

    const countMatric = await client.query(
      'SELECT COUNT(*)::int AS count FROM students WHERE matric_number = $1',
      ['EES/23/24/0400']
    );
    if (Number(countMatric.rows[0].count) !== 1) throw new Error('POSTCHECK_FAIL: matric not unique');

    await client.query('COMMIT');
    console.log(JSON.stringify({
      repair: 'COMMITTED',
      beforeCursor: 23,
      afterCursor: 23,
      rowCount: update.rowCount,
      studentAfter: post.rows[0],
      uniqueCloudSync: Number(countCloudSync.rows[0].count),
      uniqueMatric: Number(countMatric.rows[0].count),
    }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.log(JSON.stringify({
      repair: 'ROLLED_BACK',
      failure: String(err && err.message ? err.message : err),
    }, null, 2));
  } finally {
    await client.end().catch(() => undefined);
  }
})();
