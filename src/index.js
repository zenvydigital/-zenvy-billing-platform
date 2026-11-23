'use strict';

/**
 * Zenvy Digitals Billing Platform — long-running server entry
 * (Render / Docker / local). `npm start` runs this file.
 *
 * The Express app itself lives in src/app.js (shared with the Vercel
 * serverless entry api/index.js). This file only owns startup:
 * migrations, then listen().
 *
 * Migrations run at startup when DATABASE_URL is set; a missing database
 * never blocks startup — /health simply reports db: "not-configured".
 *
 * Serverless (Vercel) NEVER runs migrations at startup: Vercel sets
 * VERCEL=1, and start() skips migrate() there. On Vercel the migrations
 * are applied once in the Supabase SQL Editor from db/all-migrations.sql
 * (see DEPLOY.md). The app still works when migrations were applied
 * externally — migrate() is idempotent, and on Vercel it is skipped
 * entirely, so a missing schema_migrations table can never fail a request.
 */

const app = require('./app');
const { migrate } = require('./migrate');

const PORT = process.env.PORT || 3000;

async function start() {
  if (process.env.VERCEL === '1') {
    // Serverless: no startup migrations, no listen(). Migrations were
    // applied once in the Supabase SQL Editor (db/all-migrations.sql).
    console.log('[start] Vercel serverless mode — startup migrations skipped (applied via Supabase SQL Editor).');
  } else if (process.env.DATABASE_URL) {
    try {
      await migrate();
    } catch (err) {
      console.error('[start] migrations failed (server still starting):', err.message);
    }
  } else {
    console.log('[start] DATABASE_URL not set — running without a database (scaffold mode).');
  }

  app.listen(PORT, () => {
    console.log(`[start] Zenvy Billing Platform listening on port ${PORT}`);
    console.log(`[start] health: http://localhost:${PORT}/health`);
  });
}

if (require.main === module) start();

module.exports = app;
