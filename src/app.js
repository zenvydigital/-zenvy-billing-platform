'use strict';

/**
 * Zenvy Digitals Billing Platform — Express app factory (shared entry).
 *
 * This module builds the Express app and exports it. It does NOT listen
 * and does NOT run migrations — the two entry points own that:
 *   - src/index.js  — long-running server (Render / Docker / local):
 *                     runs migrations at startup, then app.listen(PORT).
 *   - api/index.js  — Vercel serverless (Hobby): exports this app as a
 *                     function; Vercel invokes it per request. Migrations
 *                     NEVER run here (see db/all-migrations.sql — they are
 *                     applied once in the Supabase SQL Editor instead).
 *
 * Serves:
 *   GET /health   — liveness + DB status (used by Render's health check)
 *   GET /         — the app UI (public/index.html + public/app.js)
 *   /api/auth     — register / login / logout / me
 *   /api/clinics  — clinics, flags, dashboard, AR, reports, alerts, audit
 *   /api/clinics/:clinicId/* — patients, referrals, verifications,
 *     authorizations, sessions, claims, denials, payer calls, ERA, CSV
 *   /api/clinics/:clinicId/subscription — trial/active/pause/resume/cancel
 *   /api/clinics/:clinicId/alerts/send-digest + /alert-digests (Pass 3)
 *   /api/paddle/webhook — Paddle subscription events (Pass 3, raw body)
 *   /api/automation — the 5 automation rules + run history (Pass 3)
 *   /api/internal/run-daily — daily sweep for the external scheduler (Pass 3)
 *   /api/zenvy/costs — Costs & Model, Zenvy owner only (Pass 3)
 *   /api/demo     — demo data loader + one-click remove (owner only)
 *   /api/clinics/:clinicId/demo — sample data inside a trial clinic
 *     (Pass 5: clinic owner loads/removes sample data in their OWN clinic)
 *   /api/public   — public 7-day trial signup, no login (Pass 5)
 *   /api/integrations — vendor connections + setConnectionMode (Pass 4)
 *   /api/clinics/:clinicId/edi/batches + /claims/:id/status-check (Pass 4)
 *   /api/clinics/:clinicId/appeal-drafts — auto-appeal drafts (Pass 4)
 *   /api/clinics/:clinicId/call-queue/export + /import-results — Sara dialer bridge (Pass 4)
 *   /api/portal   — per-clinic owner view (Pass 4)
 *   /api/clinics/:clinicId/claims/:id/risk — denial-risk score (Pass 4)
 *
 * A missing database never blocks startup — /health simply reports
 * db: "not-configured".
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const { ping } = require('./db');

const app = express();

// Paddle webhook first, with a RAW body parser — the signature is verified
// against the exact request bytes, so the JSON parser must not run first.
app.use('/api/paddle/webhook', express.raw({ type: 'application/json', limit: '2mb' }), require('./routes/paddle-webhook'));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (req, res) => {
  const db = await ping();
  res.json({
    ok: db !== 'down',
    service: 'zenvy-billing-platform',
    version: '0.5.0-pass5',
    db,
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/public', require('./routes/public'));
app.use('/api/demo', require('./routes/demo').router);
app.use('/api/clinics/:clinicId/demo', require('./routes/demo').clinicDemo);
app.use('/api/automation', require('./routes/automation'));
app.use('/api/internal', require('./routes/internal'));
app.use('/api/zenvy', require('./routes/zenvy'));
app.use('/api/integrations', require('./routes/integrations').platform);
app.use('/api/portal', require('./routes/portal'));
app.use('/api/clinics', require('./routes/clinics'));
app.use('/api/clinics/:clinicId/subscription', require('./routes/subscriptions'));
app.use('/api/clinics/:clinicId', require('./routes/patients'));
app.use('/api/clinics/:clinicId', require('./routes/billing'));
app.use('/api/clinics/:clinicId', require('./routes/era'));
app.use('/api/clinics/:clinicId', require('./routes/csv'));
app.use('/api/clinics/:clinicId', require('./routes/alerts'));
app.use('/api/clinics/:clinicId', require('./routes/appeals'));
app.use('/api/clinics/:clinicId', require('./routes/dialer'));
app.use('/api/clinics/:clinicId', require('./routes/integrations').clinic);

// Unknown API route — plain JSON, never an HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Unknown API route.' });
});

// Error handler: ApiError → its status + plain message; database constraint
// failures → plain language (never raw SQL); everything else → 500.
app.use((err, req, res, next) => {
  if (err && err.status) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  if (err && err.code === '23505') {
    return res.status(400).json({ ok: false, error: 'That record already exists — check for a duplicate and try again.' });
  }
  if (err && err.code === '23503') {
    return res.status(409).json({ ok: false, error: 'That record is still linked to other records — remove the links first.' });
  }
  console.error('[error]', err && err.stack ? err.stack : err);
  return res.status(500).json({ ok: false, error: 'Something went wrong on the server — please try again.' });
});

module.exports = app;
