'use strict';

/**
 * Automation engine (Pass 3): the 5 automation rules + daily sweep.
 *
 * Rules (seeded ON in 003_platform.sql; the owner toggles each):
 *   eligibility_checks — re-check pending verifications (simulation:
 *     a pending verification with a payer on file resolves to eligible
 *     and gets a SIM-271 reference; one without a payer stays pending).
 *   auth_scan — mark authorizations expiring (≤30 days), expired
 *     (past end date) or exhausted (units used up). Expiring auths
 *     still cover claims — the scrubber accepts 'active' and 'expiring'.
 *   followup_scan — list open denials with appeal deadlines ≤14 days
 *     and submitted claims older than 30 days (read-only; no state change).
 *   call_runner — process ONE queued payer call per run, for opt-in
 *     clinics only (simulation: logs a Sara call with outcome 'pending'
 *     — payer line busy, queued for retry — no live Twilio call).
 *   alert_digest — compose + queue + attempt delivery of today's digest
 *     for every clinic with alerts on and an alert email set.
 *
 * Every rule run writes an automation_runs row (result JSONB + error)
 * and updates automation_rules.last_run_at. A rule that throws is
 * recorded and the sweep continues with the next rule.
 * The daily sweep is an HTTP endpoint (POST /api/internal/run-daily,
 * CRON_SECRET header) — Render free has no cron jobs — and the same
 * sweep runs from the Automation tab (POST /api/automation/run-daily).
 */

const { daysUntil } = require('./util');
const { audit } = require('./audit');
const { queueAndSendDigest } = require('./digest');

const RULE_ORDER = ['eligibility_checks', 'auth_scan', 'followup_scan', 'call_runner', 'alert_digest'];

const RULE_LABELS = {
  eligibility_checks: 'Eligibility re-checks',
  auth_scan: 'Authorization expiry scan',
  followup_scan: 'Denial + AR follow-up scan',
  call_runner: 'Sara payer-call runner',
  alert_digest: 'Email alert digest',
};

async function recordRun(q, ruleKey, result, error) {
  const ins = await q(
    `INSERT INTO automation_runs (rule_key, result, error, finished_at) VALUES ($1, $2, $3, now()) RETURNING *`,
    [ruleKey, JSON.stringify(result || {}), error || null]
  );
  await q('UPDATE automation_rules SET last_run_at = now(), updated_at = now() WHERE rule_key = $1', [ruleKey]);
  return ins.rows[0];
}

/** eligibility_checks: resolve pending verifications that have a payer (simulation). */
async function runEligibilityChecks(q) {
  const { rows } = await q(
    `SELECT * FROM verifications WHERE status = 'pending' AND payer IS NOT NULL AND payer <> '' ORDER BY created_at ASC`
  );
  const resolved = [];
  for (const v of rows) {
    await q(
      `UPDATE verifications SET status = 'eligible', edi_271_ref = $1, updated_at = now() WHERE id = $2`,
      [`SIM-271-${v.id}`, v.id]
    );
    resolved.push(v.id);
  }
  const left = await q(`SELECT count(*)::int AS n FROM verifications WHERE status = 'pending'`);
  return {
    simulation: true,
    resolved: resolved.length,
    resolvedIds: resolved,
    stillPending: left.rows[0].n,
    note: 'Simulation — no live payer connection. Pending verifications with a payer on file were marked eligible; ones without a payer stay pending.',
  };
}

/** auth_scan: update authorization statuses by end date and units. */
async function runAuthScan(q) {
  const { rows } = await q(`SELECT * FROM authorizations WHERE status IN ('active', 'expiring') ORDER BY end_date ASC`);
  const alerts = [];
  let expiring = 0;
  let expired = 0;
  let exhausted = 0;
  for (const a of rows) {
    const days = daysUntil(a.end_date);
    const unitsLeft = (a.total_units || 0) - (a.units_used || 0);
    let next = null;
    if (days !== null && days < 0) next = 'expired';
    else if ((a.total_units || 0) > 0 && unitsLeft <= 0) next = 'exhausted';
    else if (days !== null && days <= 30) next = 'expiring';
    if (next && next !== a.status) {
      await q(`UPDATE authorizations SET status = $1, updated_at = now() WHERE id = $2`, [next, a.id]);
    }
    const finalStatus = next || a.status;
    if (finalStatus === 'expiring') {
      expiring += 1;
      alerts.push({ auth_number: a.auth_number, days_left: days, units_remaining: unitsLeft });
    } else if (finalStatus === 'expired') expired += 1;
    else if (finalStatus === 'exhausted') exhausted += 1;
  }
  return { expiring, expired, exhausted, alerts, note: 'Expiring authorizations still cover claims — the scrubber accepts active and expiring.' };
}

/** followup_scan: open denials near deadline + old submitted claims (read-only). */
async function runFollowupScan(q) {
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const denials = await q(
    `SELECT d.id, d.claim_id, d.denial_code, d.appeal_deadline FROM denials d
      WHERE d.status = 'open' AND d.appeal_deadline <= $1 ORDER BY d.appeal_deadline ASC`,
    [soon]
  );
  const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const claims = await q(
    `SELECT c.id, c.date_of_service, c.billed_amount, c.paid_amount FROM claims c
      WHERE c.status = 'submitted' AND c.date_of_service <= $1 ORDER BY c.date_of_service ASC`,
    [old]
  );
  return {
    denialsNearDeadline: denials.rows.length,
    denialClaims: denials.rows.map((d) => d.claim_id),
    oldSubmittedClaims: claims.rows.length,
    oldClaimIds: claims.rows.map((c) => c.id),
    note: 'Read-only scan — nothing was changed. Work the oldest items first.',
  };
}

/** call_runner: process ONE queued payer call (opt-in clinics only, simulation). */
async function runCallRunner(q) {
  const { rows } = await q(
    `SELECT q.* FROM payer_call_queue q
      JOIN clinics c ON c.id = q.clinic_id
     WHERE q.status = 'queued' AND c.payer_calls_opt_in = TRUE
     ORDER BY q.created_at ASC LIMIT 1`
  );
  if (rows.length === 0) {
    return { processed: 0, note: 'Queue is empty (or no opt-in clinic has a queued call).' };
  }
  const item = rows[0];
  await q(`UPDATE payer_call_queue SET status = 'processing', updated_at = now() WHERE id = $1`, [item.id]);
  const ins = await q(
    `INSERT INTO payer_calls (clinic_id, claim_id, queue_id, caller, outcome, status_answer, next_action, is_simulated)
     VALUES ($1, $2, $3, 'sara', 'pending', $4, $5, TRUE) RETURNING *`,
    [
      item.clinic_id,
      item.claim_id,
      item.id,
      'Automated sweep: payer line busy — queued for a retry. (Simulation — no live Twilio call was placed.)',
      'Retry on the next sweep.',
    ]
  );
  await q(`UPDATE payer_call_queue SET status = 'done', updated_at = now() WHERE id = $1`, [item.id]);
  await audit(q, {
    actor: null,
    clinicId: item.clinic_id,
    entity: 'payer_call',
    entityId: ins.rows[0].id,
    action: 'create',
    detail: { queue_id: item.id, claim_id: item.claim_id, caller: 'sara', outcome: 'pending', simulation: true },
  });
  return { processed: 1, queueId: item.id, claimId: item.claim_id, callId: ins.rows[0].id, simulation: true };
}

/** alert_digest: today's digest for every clinic with alerts on + an email set. */
async function runAlertDigest(q) {
  const { rows: clinics } = await q(
    `SELECT * FROM clinics WHERE alerts_enabled = TRUE AND alert_email IS NOT NULL AND alert_email <> '' ORDER BY name`
  );
  const digests = [];
  for (const clinic of clinics) {
    const r = await queueAndSendDigest(q, clinic);
    digests.push({ clinicId: clinic.id, clinic: clinic.name, items: r.items.length, sent: r.sent, note: r.note });
    await audit(q, {
      actor: null,
      clinicId: clinic.id,
      entity: 'alert_digest',
      entityId: r.digest ? r.digest.id : null,
      action: 'send',
      detail: { digest_date: r.digest ? r.digest.digest_date : null, items: r.items.length, sent: r.sent },
    });
  }
  return { clinicsChecked: clinics.length, digests };
}

/** Run one rule by key (manual runs ignore the on/off toggle — explicit action). */
async function runRule(q, ruleKey, actor) {
  const runners = {
    eligibility_checks: runEligibilityChecks,
    auth_scan: runAuthScan,
    followup_scan: runFollowupScan,
    call_runner: runCallRunner,
    alert_digest: runAlertDigest,
  };
  const run = runners[ruleKey];
  if (!run) throw new Error(`Unknown automation rule: ${ruleKey}`);
  const started = new Date();
  try {
    const result = await run(q);
    const row = await recordRun(q, ruleKey, result, null);
    await audit(q, { actor, clinicId: null, entity: 'automation', entityId: row.id, action: 'rule-run', detail: { rule: ruleKey, ...summarize(result) } });
    return { rule: ruleKey, label: RULE_LABELS[ruleKey], ran: true, result, runId: row.id, startedAt: started.toISOString() };
  } catch (err) {
    const row = await recordRun(q, ruleKey, {}, err.message);
    return { rule: ruleKey, label: RULE_LABELS[ruleKey], ran: false, error: err.message, runId: row.id, startedAt: started.toISOString() };
  }
}

function summarize(result) {
  const out = {};
  for (const k of ['resolved', 'expiring', 'expired', 'exhausted', 'processed', 'denialsNearDeadline', 'oldSubmittedClaims']) {
    if (result[k] !== undefined) out[k] = result[k];
  }
  return out;
}

/** Run the whole daily sweep: every enabled rule, in order. Disabled rules are skipped. */
async function runDailySweep(q, actor) {
  const startedAt = new Date().toISOString();
  const { rows: rules } = await q('SELECT rule_key, enabled FROM automation_rules ORDER BY rule_key');
  const enabled = new Map(rules.map((r) => [r.rule_key, r.enabled]));
  const summary = { startedAt, rules: {} };
  for (const key of RULE_ORDER) {
    if (!enabled.get(key)) {
      summary.rules[key] = { label: RULE_LABELS[key], ran: false, skipped: true, note: 'Rule is off — turn it on to include it in the daily sweep.' };
      continue;
    }
    summary.rules[key] = await runRule(q, key, actor);
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

module.exports = {
  RULE_ORDER,
  RULE_LABELS,
  runRule,
  runDailySweep,
  runEligibilityChecks,
  runAuthScan,
  runFollowupScan,
  runCallRunner,
  runAlertDigest,
};
