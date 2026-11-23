'use strict';

/**
 * Clinics: CRUD + owner-only flags + dashboard / AR / reports / audit read.
 *
 * Flags (owner-only to change): baa_signed, payer_calls_opt_in,
 * alerts_enabled, alert_email. A biller may update contact details only.
 * Only a Zenvy platform owner (clinic_id NULL) may create or delete clinics.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, applyMerge, toMoney, isoDate, daysUntil } = require('../util');
const { requireAuth, requireWrite, requirePlatformOwner, requireClinicOwner, loadClinic } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth);

const GENERAL_FIELDS = ['name', 'city', 'state', 'timezone', 'contact_name', 'contact_email', 'status'];
const FLAG_FIELDS = ['baa_signed', 'payer_calls_opt_in', 'alerts_enabled', 'alert_email'];

function cleanClinic(c) {
  return cleanRow(c, [], ['trial_ends_at']);
}

/** List clinics: Zenvy owner sees all; clinic users see only their own. */
router.get('/', async (req, res, next) => {
  try {
    let rows;
    if (req.user.clinic_id === null) {
      rows = (await query('SELECT * FROM clinics ORDER BY name')).rows;
    } else {
      rows = (await query('SELECT * FROM clinics WHERE id = $1', [req.user.clinic_id])).rows;
    }
    res.json({ ok: true, clinics: rows.map(cleanClinic) });
  } catch (err) {
    next(err);
  }
});

/** Create a clinic — Zenvy platform owner only. */
router.post('/', requirePlatformOwner, async (req, res, next) => {
  try {
    if (req.user.clinic_id !== null) {
      throw new ApiError(403, 'Only the Zenvy platform owner can create clinics.');
    }
    const name = String(req.body.name || '').trim();
    if (!name) throw new ApiError(400, 'Clinic name is required.');
    const ins = await query(
      `INSERT INTO clinics (name, city, state, timezone, contact_name, contact_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name,
        req.body.city || null,
        req.body.state || null,
        req.body.timezone || 'America/New_York',
        req.body.contact_name || null,
        req.body.contact_email || null,
      ]
    );
    const clinic = ins.rows[0];
    await audit(query, { actor: req.user, clinicId: clinic.id, entity: 'clinic', entityId: clinic.id, action: 'create', detail: { name } });
    res.status(201).json({ ok: true, clinic: cleanClinic(clinic) });
  } catch (err) {
    next(err);
  }
});

router.get('/:clinicId', loadClinic, (req, res) => {
  res.json({ ok: true, clinic: cleanClinic(req.clinic) });
});

/** Update a clinic — merge, never blank omitted fields; flags are owner-only. */
router.patch('/:clinicId', loadClinic, requireWrite, async (req, res, next) => {
  try {
    const wantsFlags = FLAG_FIELDS.some((f) => req.body[f] !== undefined);
    if (wantsFlags && req.user.role !== 'owner' && req.user.role !== 'clinic') {
      throw new ApiError(403, 'Only the clinic owner can change BAA, payer-call opt-in or alert settings.');
    }
    if (req.body.status !== undefined && !['active', 'paused'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be active or paused.');
    }
    const updated = await applyMerge(query, 'clinics', req.clinic, [...GENERAL_FIELDS, ...FLAG_FIELDS], req.body);
    await audit(query, { actor: req.user, clinicId: updated.id, entity: 'clinic', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, clinic: cleanClinic(updated) });
  } catch (err) {
    next(err);
  }
});

/** Delete a clinic — only when it holds no REAL billing data (plain message otherwise).
 * Sample (is_demo) rows never block a delete: a trial clinic whose only data is the
 * auto-loaded sample set deletes cleanly, and its sample rows are purged with it.
 * Real rows are identified through the is_demo flag where the table has one
 * (patients, claims, referrals) and through their sample patient/claim otherwise
 * (sessions, authorizations, verifications hang off the patient; denials off the
 * claim). ERA lines are never sample data, so any ERA line blocks. */
router.delete('/:clinicId', loadClinic, requirePlatformOwner, async (req, res, next) => {
  try {
    if (req.user.clinic_id !== null) {
      throw new ApiError(403, 'Only the Zenvy platform owner can delete clinics.');
    }
    const cid = req.clinic.id;
    const counts = {};
    const countSql = async (label, sql) => {
      const r = await query(sql, [cid]);
      if (r.rows[0].n > 0) counts[label] = r.rows[0].n;
    };
    await countSql('referrals', `SELECT count(*)::int AS n FROM referrals WHERE clinic_id = $1 AND is_demo IS NOT TRUE`);
    await countSql('patients', `SELECT count(*)::int AS n FROM patients WHERE clinic_id = $1 AND is_demo IS NOT TRUE`);
    await countSql('claims', `SELECT count(*)::int AS n FROM claims WHERE clinic_id = $1 AND is_demo IS NOT TRUE`);
    await countSql('sessions', `SELECT count(*)::int AS n FROM sessions WHERE clinic_id = $1 AND patient_id NOT IN (SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE)`);
    await countSql('authorizations', `SELECT count(*)::int AS n FROM authorizations WHERE clinic_id = $1 AND patient_id NOT IN (SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE)`);
    await countSql('verifications', `SELECT count(*)::int AS n FROM verifications WHERE clinic_id = $1 AND patient_id NOT IN (SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE)`);
    await countSql('denials', `SELECT count(*)::int AS n FROM denials WHERE clinic_id = $1 AND patient_id NOT IN (SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE) AND claim_id NOT IN (SELECT id FROM claims WHERE clinic_id = $1 AND is_demo = TRUE)`);
    await countSql('ERA lines', `SELECT count(*)::int AS n FROM era_lines WHERE clinic_id = $1`);
    if (Object.keys(counts).length > 0) {
      const list = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
      throw new ApiError(409, `This clinic still holds data (${list}). Remove or move that data first — clinics with billing records cannot be deleted.`);
    }
    // No real billing data: purge any sample rows (dependency order), then its
    // users and the clinic itself.
    for (const sql of [
      `DELETE FROM payer_calls WHERE clinic_id = $1`,
      `DELETE FROM payer_call_queue WHERE clinic_id = $1`,
      `DELETE FROM appeal_drafts WHERE claim_id IN (SELECT id FROM claims WHERE clinic_id = $1)`,
      `DELETE FROM era_lines WHERE clinic_id = $1`,
      `DELETE FROM denials WHERE clinic_id = $1`,
      `DELETE FROM claims WHERE clinic_id = $1`,
      `DELETE FROM sessions WHERE clinic_id = $1`,
      `DELETE FROM authorizations WHERE clinic_id = $1`,
      `DELETE FROM verifications WHERE clinic_id = $1`,
      `DELETE FROM referrals WHERE clinic_id = $1`,
      `DELETE FROM patients WHERE clinic_id = $1`,
    ]) await query(sql, [cid]);
    await query('DELETE FROM users WHERE clinic_id = $1', [cid]);
    await query('DELETE FROM clinics WHERE id = $1', [cid]);
    await audit(query, { actor: req.user, clinicId: null, entity: 'clinic', entityId: cid, action: 'delete', detail: { name: req.clinic.name } });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

/** Users inside a clinic (the clinic's owner only). */
router.get('/:clinicId/users', loadClinic, requireClinicOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, clinic_id, name, email, role, created_at FROM users WHERE clinic_id = $1 ORDER BY name',
      [req.clinic.id]
    );
    res.json({ ok: true, users: rows.map((u) => cleanRow(u)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:clinicId/users/:userId', loadClinic, requireClinicOwner, async (req, res, next) => {
  try {
    if (Number(req.params.userId) === req.user.id) {
      throw new ApiError(400, 'You cannot remove your own account.');
    }
    const { rows } = await query('SELECT * FROM users WHERE id = $1 AND clinic_id = $2', [req.params.userId, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'User not found in this clinic.');
    await query('DELETE FROM users WHERE id = $1', [req.params.userId]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'user', entityId: Number(req.params.userId), action: 'delete', detail: { email: rows[0].email } });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

/** Dashboard — leads with "Recovered this month". */
router.get('/:clinicId/dashboard', loadClinic, async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const q = async (sql, params) => (await query(sql, params)).rows;

    const recovered = await q(
      `SELECT COALESCE(SUM(paid_amount), 0) AS total, count(*)::int AS n
         FROM claims WHERE clinic_id = $1 AND status IN ('paid', 'partial')
         AND updated_at >= $2`,
      [cid, monthStart]
    );
    const openAr = await q(
      `SELECT COALESCE(SUM(billed_amount - paid_amount), 0) AS total, count(*)::int AS n
         FROM claims WHERE clinic_id = $1 AND status IN ('draft', 'ready', 'submitted', 'partial', 'denied')`,
      [cid]
    );
    const openDenials = await q(
      "SELECT count(*)::int AS n FROM denials WHERE clinic_id = $1 AND status = 'open'",
      [cid]
    );
    const expiring = await q(
      `SELECT count(*)::int AS n FROM authorizations
        WHERE clinic_id = $1 AND status IN ('active', 'expiring')
        AND end_date <= $2`,
      [cid, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)]
    );
    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM claims WHERE clinic_id = $1) AS claims,
         (SELECT count(*)::int FROM patients WHERE clinic_id = $1 AND status = 'active') AS patients,
         (SELECT count(*)::int FROM sessions WHERE clinic_id = $1 AND status = 'completed') AS sessions,
         (SELECT count(*)::int FROM authorizations WHERE clinic_id = $1) AS auths,
         (SELECT count(*)::int FROM patients WHERE clinic_id = $1 AND is_demo = TRUE) AS sample_patients,
         (SELECT count(*)::int FROM payer_call_queue WHERE clinic_id = $1 AND status = 'queued') AS queued_calls`,
      [cid]
    );
    res.json({
      ok: true,
      dashboard: {
        recoveredThisMonth: toMoney(recovered[0].total),
        paidClaimsThisMonth: recovered[0].n,
        openAr: toMoney(openAr[0].total),
        openArClaims: openAr[0].n,
        openDenials: openDenials[0].n,
        authsExpiring30d: expiring[0].n,
        totalClaims: Number(counts[0].claims),
        activePatients: Number(counts[0].patients),
        completedSessions: Number(counts[0].sessions),
        totalAuths: Number(counts[0].auths),
        // Number() guards the counts: pg-mem returns multi-subquery
        // counts as [n] arrays in tests; real Postgres returns plain
        // ints. Either way the API answers with a number.
        hasSampleData: Number(counts[0].sample_patients) > 0,
        queuedCalls: Number(counts[0].queued_calls),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** AR aging: buckets by date of service + follow-up list, oldest first. */
router.get('/:clinicId/ar', loadClinic, async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const { rows } = await query(
      `SELECT c.*, p.initials AS patient_initials
         FROM claims c JOIN patients p ON p.id = c.patient_id
        WHERE c.clinic_id = $1 AND c.status IN ('submitted', 'partial', 'denied')
        ORDER BY c.date_of_service ASC`,
      [cid]
    );
    const buckets = { '0-30': { count: 0, balance: 0 }, '31-60': { count: 0, balance: 0 }, '61-90': { count: 0, balance: 0 }, '90+': { count: 0, balance: 0 } };
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const items = rows.map((r) => {
      const balance = toMoney(r.billed_amount) - toMoney(r.paid_amount);
      const ageDays = Math.floor((today.getTime() - new Date(isoDate(r.date_of_service)).getTime()) / 86400000);
      const bucket = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+';
      buckets[bucket].count += 1;
      buckets[bucket].balance += balance;
      return cleanRow({ ...r, balance, age_days: ageDays, bucket }, ['billed_amount', 'paid_amount', 'balance'], ['date_of_service']);
    });
    for (const b of Object.values(buckets)) b.balance = Math.round(b.balance * 100) / 100;
    res.json({ ok: true, ar: { buckets, items } });
  } catch (err) {
    next(err);
  }
});

/** Weekly report: last 7 days + totals to date. */
router.get('/:clinicId/reports/weekly', loadClinic, async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const q = async (sql, params) => (await query(sql, params)).rows;
    const week = await q(
      `SELECT
         (SELECT count(*)::int FROM claims WHERE clinic_id = $1 AND created_at >= $2) AS claims_created,
         (SELECT count(*)::int FROM claims WHERE clinic_id = $1 AND status = 'submitted' AND updated_at >= $2) AS claims_submitted,
         (SELECT count(*)::int FROM claims WHERE clinic_id = $1 AND status IN ('paid', 'partial') AND updated_at >= $2) AS claims_paid,
         (SELECT COALESCE(SUM(paid_amount), 0) FROM claims WHERE clinic_id = $1 AND status IN ('paid', 'partial') AND updated_at >= $2) AS recovered,
         (SELECT count(*)::int FROM denials WHERE clinic_id = $1 AND created_at >= $2) AS denials_opened`,
      [cid, weekAgo]
    );
    const totals = await q(
      `SELECT
         (SELECT count(*)::int FROM claims WHERE clinic_id = $1) AS total_claims,
         (SELECT COALESCE(SUM(billed_amount), 0) FROM claims WHERE clinic_id = $1) AS total_billed,
         (SELECT COALESCE(SUM(paid_amount), 0) FROM claims WHERE clinic_id = $1 AND status IN ('paid', 'partial')) AS total_recovered,
         (SELECT count(*)::int FROM denials WHERE clinic_id = $1 AND status = 'open') AS open_denials,
         (SELECT COALESCE(SUM(billed_amount - paid_amount), 0) FROM claims WHERE clinic_id = $1 AND status IN ('draft', 'ready', 'submitted', 'partial', 'denied')) AS open_ar`,
      [cid]
    );
    res.json({
      ok: true,
      report: {
        week: {
          claimsCreated: Number(week[0].claims_created),
          claimsSubmitted: Number(week[0].claims_submitted),
          claimsPaid: Number(week[0].claims_paid),
          recovered: toMoney(week[0].recovered),
          denialsOpened: Number(week[0].denials_opened),
        },
        totals: {
          totalClaims: Number(totals[0].total_claims),
          totalBilled: toMoney(totals[0].total_billed),
          totalRecovered: toMoney(totals[0].total_recovered),
          openDenials: Number(totals[0].open_denials),
          openAr: toMoney(totals[0].open_ar),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Alerts: auths expiring within 30 days + appeal deadlines within 14 days. */
router.get('/:clinicId/alerts', loadClinic, async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const auths = await query(
      `SELECT a.*, p.initials AS patient_initials FROM authorizations a
        JOIN patients p ON p.id = a.patient_id
       WHERE a.clinic_id = $1 AND a.status IN ('active', 'expiring')
         AND a.end_date <= $2
       ORDER BY a.end_date ASC`,
      [cid, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)]
    );
    const denials = await query(
      `SELECT d.*, c.date_of_service FROM denials d
        JOIN claims c ON c.id = d.claim_id
       WHERE d.clinic_id = $1 AND d.status = 'open'
         AND d.appeal_deadline <= $2
       ORDER BY d.appeal_deadline ASC`,
      [cid, new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)]
    );
    res.json({
      ok: true,
      alerts: {
        authExpiries: auths.rows.map((a) => cleanRow({
          ...a,
          days_left: daysUntil(a.end_date),
          units_remaining: (a.total_units || 0) - (a.units_used || 0),
        }, [], ['start_date', 'end_date'])),
        appealDeadlines: denials.rows.map((d) => cleanRow({
          ...d, days_left: daysUntil(d.appeal_deadline),
        }, [], ['appeal_deadline', 'date_of_service'])),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Audit log — read-only, newest first. */
router.get('/:clinicId/audit', loadClinic, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(toMoney(req.query.limit) || 100, 1), 500);
    const { rows } = await query(
      `SELECT * FROM audit_log WHERE clinic_id = $1 OR clinic_id IS NULL
        ORDER BY created_at DESC LIMIT $2`,
      [req.clinic.id, limit]
    );
    res.json({ ok: true, audit: rows.map((r) => cleanRow(r)) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
