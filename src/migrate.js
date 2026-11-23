'use strict';

/**
 * Migration runner — applies db/migrations/*.sql in filename order.
 *
 * Applied files are recorded in schema_migrations so re-runs are safe.
 * Run with: npm run migrate
 * (Also runs automatically at server start — see src/index.js.)
 *
 * If DATABASE_URL is unset the runner prints a clear message and exits 0:
 * migrations are a deployment step, not a reason to fail local scaffold runs.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, query } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function migrate(client) {
  const q = client
    ? (text, params) => client.query(text, params)
    : (text, params) => query(text, params);

  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const { rows } = await q('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Real-Postgres-only files (marked REAL-POSTGRES-ONLY, e.g. the
    // audit-log trigger — pg-mem cannot run plpgsql or CREATE TRIGGER)
    // are skipped in the test environment only. In production they apply
    // normally. The test harness asserts their DDL by reading the file
    // instead (see test/migrations.test.js).
    if (process.env.NODE_ENV === 'test' && sql.includes('REAL-POSTGRES-ONLY')) {
      console.log(`[migrate] skipping ${file} in test env (real-Postgres-only DDL)`);
      await q('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      continue;
    }
    console.log(`[migrate] applying ${file} ...`);
    await q(sql);
    await q('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    ran += 1;
  }
  console.log(`[migrate] done — ${ran} new migration(s), ${files.length} total file(s).`);
  return ran;
}

async function main() {
  if (!pool) {
    console.log('[migrate] DATABASE_URL is not set — nothing to migrate. Set it in .env (Supabase) and re-run.');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migrate(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { migrate };
