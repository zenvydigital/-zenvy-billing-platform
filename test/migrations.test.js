'use strict';

/**
 * Migration smoke test (dev only) — runs every db/migrations/*.sql file
 * against an in-memory Postgres (pg-mem) to catch SQL syntax errors
 * without a live database. No real data, no network.
 *
 * Run with: npm run test:migrations
 */

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const EXPECTED_TABLES = [
  // Note: schema_migrations is created by the runner (src/migrate.js), not by
  // the migration files, so it is not expected here.
  'clinics', 'users', 'patients', 'referrals', 'verifications', 'authorizations',
  'sessions', 'claims', 'denials', 'payer_calls', 'payer_call_queue',
  'appeal_drafts', 'era_lines',
  'audit_log', 'automation_rules', 'automation_runs', 'alert_emails', 'connections',
];

async function main() {
  const db = newDb();
  // pg-mem implements very few native functions; register the ones the
  // migrations use (real Postgres has char_length natively — this is a
  // test-emulator gap, not a SQL bug).
  db.public.registerFunction({
    name: 'char_length',
    args: ['text'],
    returns: 'int',
    implementation: (s) => (s === null || s === undefined ? null : [...s].length),
  });
  db.public.registerFunction({
    name: 'length',
    args: ['text'],
    returns: 'int',
    implementation: (s) => (s === null || s === undefined ? null : [...s].length),
  });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error('no migration files found');

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Real-Postgres-only files (marked REAL-POSTGRES-ONLY — the audit-log
    // trigger needs plpgsql + CREATE TRIGGER, which pg-mem cannot run)
    // are NOT executed here; their DDL is asserted by reading the file
    // instead. On real Postgres (Supabase) they apply normally.
    if (sql.includes('REAL-POSTGRES-ONLY')) {
      if (!sql.includes('CREATE TRIGGER') || !sql.includes('audit_log') || !sql.includes('RAISE EXCEPTION')) {
        throw new Error(`${file} is marked real-Postgres-only but does not contain the audit-log trigger DDL`);
      }
      console.log(`[test] ${file} SKIPPED in pg-mem (real-Postgres-only) — trigger DDL present`);
      continue;
    }
    // pg-mem cannot run multi-statement scripts with parameters in one go
    // the same way node-postgres does, so execute the file as a single query.
    await pool.query(sql);
    console.log(`[test] ${file} OK`);
  }

  // Verify via information_schema (pg-mem has no pg_tables catalog view).
  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);

  // Seed checks: 5 automation rules + 7 vendor connections must exist.
  const rules = await pool.query('SELECT count(*)::int AS n FROM automation_rules');
  const conns = await pool.query('SELECT count(*)::int AS n FROM connections');
  if (rules.rows[0].n !== 5) throw new Error(`expected 5 automation rules, got ${rules.rows[0].n}`);
  if (conns.rows[0].n !== 7) throw new Error(`expected 7 connections, got ${conns.rows[0].n}`);

  console.log(`[test] all ${files.length} migration(s) applied; ${EXPECTED_TABLES.length} tables present; seeds OK (5 rules, 7 connections).`);
  await pool.end();
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
