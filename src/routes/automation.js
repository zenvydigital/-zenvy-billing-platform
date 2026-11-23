'use strict';

/**
 * Automation (Pass 3): the 5 automation rules + run history + manual runs.
 *
 * Platform-level, Zenvy-owner-only (clinic users never see it):
 *   GET  /api/automation/rules        — the 5 rules + on/off + last run
 *   PATCH /api/automation/rules/:key  — toggle a rule on/off
 *   GET  /api/automation/runs         — run history, newest first
 *   POST /api/automation/run/:key     — run one rule now (manual runs
 *                                       ignore the on/off toggle — explicit)
 *   POST /api/automation/run-daily    — the whole daily sweep now
 *
 * The external scheduler uses POST /api/internal/run-daily (CRON_SECRET
 * header) — see routes/internal.js. Both call the same sweep.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow } = require('../util');
const { requireAuth } = require('../middleware');
const { audit } = require('../audit');
const { RULE_ORDER, RULE_LABELS, runRule, runDailySweep } = require('../automation');

const router = express.Router();
router.use(requireAuth);

function requireZenvyOwner(req, res, next) {
  if (req.user.role !== 'owner' || req.user.clinic_id !== null) {
    return next(new ApiError(403, 'Automation is managed by the Zenvy platform owner.'));
  }
  return next();
}
router.use(requireZenvyOwner);

router.get('/rules', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM automation_rules ORDER BY rule_key');
    res.json({
      ok: true,
      rules: rows.map((r) => ({
        key: r.rule_key,
        label: RULE_LABELS[r.rule_key] || r.rule_key,
        enabled: r.enabled,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/rules/:ruleKey', async (req, res, next) => {
  try {
    const key = req.params.ruleKey;
    if (!RULE_ORDER.includes(key)) {
      throw new ApiError(404, `Unknown automation rule: ${key}`);
    }
    if (typeof req.body.enabled !== 'boolean') {
      throw new ApiError(400, 'enabled must be true or false.');
    }
    const { rows } = await query(
      'UPDATE automation_rules SET enabled = $1, updated_at = now() WHERE rule_key = $2 RETURNING *',
      [req.body.enabled, key]
    );
    await audit(query, {
      actor: req.user, clinicId: null, entity: 'automation_rule', entityId: rows[0].id,
      action: 'update', detail: { rule: key, enabled: req.body.enabled },
    });
    res.json({ ok: true, rule: { key, label: RULE_LABELS[key], enabled: rows[0].enabled } });
  } catch (err) {
    next(err);
  }
});

router.get('/runs', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const { rows } = await query(
      'SELECT * FROM automation_runs ORDER BY started_at DESC, id DESC LIMIT $1',
      [limit]
    );
    res.json({
      ok: true,
      runs: rows.map((r) => cleanRow({ ...r, label: RULE_LABELS[r.rule_key] || r.rule_key })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/run-daily', async (req, res, next) => {
  try {
    const summary = await runDailySweep(query, req.user);
    res.json({ ok: true, sweep: summary });
  } catch (err) {
    next(err);
  }
});

// NOTE: this parameterized route must come AFTER /run-daily above, or
// Express would match 'daily' as :ruleKey.
router.post('/run/:ruleKey', async (req, res, next) => {
  try {
    const key = req.params.ruleKey;
    if (!RULE_ORDER.includes(key)) {
      throw new ApiError(404, `Unknown automation rule: ${key}`);
    }
    const result = await runRule(query, key, req.user);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
