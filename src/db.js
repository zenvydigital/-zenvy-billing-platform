'use strict';

/**
 * Postgres connection for the Zenvy Billing Platform.
 *
 * DATABASE_URL comes from the environment only (Render dashboard in production,
 * .env locally). No credentials are ever hard-coded.
 *
 * If DATABASE_URL is unset the pool stays null: the server still starts and
 * /health reports db: "not-configured" instead of crashing. That keeps local
 * scaffold verification possible before the Supabase database exists.
 */

const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  const connStr = process.env.DATABASE_URL;
  // Supabase (direct + pooler) and Render Postgres both require SSL;
  // a local Postgres URL has no sslmode and stays plain. node-postgres does
  // not reliably honour sslmode in the connection string, so set it here.
  const needsSSL = /sslmode=require/i.test(connStr) || /supabase\.co/i.test(connStr);
  pool = new Pool({
    connectionString: connStr,
    ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, // managed-DB cold start can take a few seconds
  });

  pool.on('error', (err) => {
    // A single idle-client error must not crash the process.
    console.error('[db] idle client error:', err.message);
  });
}

/**
 * Run a query. Throws a clear error when no database is configured so
 * route handlers can answer 503 instead of crashing.
 */
async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(text, params);
}

/** Cheap liveness check used by /health. Returns 'up' | 'down' | 'not-configured'. */
async function ping() {
  if (!pool) return 'not-configured';
  try {
    await pool.query('SELECT 1');
    return 'up';
  } catch (err) {
    console.error('[db] ping failed:', err.message);
    return 'down';
  }
}

/**
 * Swap the connection pool (used by tests to inject an in-memory pg-mem
 * pool). Production never calls this — the pool comes from DATABASE_URL.
 */
function setPool(p) {
  pool = p;
}

function getPool() {
  return pool;
}

module.exports = { pool, query, ping, setPool, getPool };
