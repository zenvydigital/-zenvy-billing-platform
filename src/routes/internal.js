'use strict';

/**
 * Internal endpoints (Pass 3): the daily sweep trigger for an external
 * scheduler. Render free has no cron jobs, so the sweep is an HTTP
 * endpoint called by UptimeRobot / cron-job.org (or the Droplet's own
 * cron after the DigitalOcean move).
 *
 *   POST /api/internal/run-daily   — header: x-cron-secret: <CRON_SECRET>
 *
 * No cookie auth here — the shared secret IS the auth. When CRON_SECRET
 * is not set the endpoint refuses with 503 (not configured), and a wrong
 * secret gets 401. The sweep itself is the same runDailySweep the
 * Automation tab calls.
 */

const express = require('express');
const { query } = require('../db');
const { runDailySweep } = require('../automation');

const router = express.Router();

router.post('/run-daily', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'Daily sweep is not configured — set CRON_SECRET in the environment.' });
  }
  if (req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'Invalid cron secret.' });
  }
  try {
    const sweep = await runDailySweep(query, null);
    res.json({ ok: true, sweep });
  } catch (err) {
    console.error('[internal/run-daily] failed:', err.message);
    res.status(500).json({ ok: false, error: 'Daily sweep failed — see the server log.' });
  }
});

module.exports = router;
