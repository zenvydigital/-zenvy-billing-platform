'use strict';

/**
 * Clinic Portal (Pass 4) — the per-clinic owner view.
 *
 *   GET /api/portal
 *
 * For a clinic owner (role owner with a clinic_id): their OWN clinic
 * only — dashboard numbers, recent claims, AR aging, alerts and the
 * subscription status, in one read-only bundle. The clinic is taken
 * from the signed-in user's own account, never from a URL parameter,
 * so a clinic can never see another clinic's data through this
 * endpoint. The Zenvy platform owner (clinic_id NULL) does not use
 * the portal — they use the main platform, which sees everything.
 * Viewers and billers get the same read-only bundle for their clinic.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, toMoney, isoDate, daysUntil } = require('../util');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    if (req.user.clinic_id === null) {
      throw new ApiError(403, 'The clinic portal is for clinic owners — the Zenvy platform owner uses the main platform.');
    }
    const { rows: clinicRows } = await query('SELECT * FROM clinics WHERE id = $1', [req.user.clinic_id]);
    if (clinicRows.length === 0) throw new ApiError(404, 'Your clinic no longer exists — contact Zenvy support.');
    const clinic = clinicRows[0];
    const cid = clinic.id;
    const q = async (sql, params) => (await query(sql, params)).rows;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const recovered = await q(
      `SELECT COALESCE(SUM(paid_amount), 0) AS total, count(*)::int AS n
         FROM claims WHERE clinic_id = $1 AND status IN ('paid', 'partial') AND updated_at >= $2`,
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
        WHERE clinic_id = $1 AND status IN ('active', 'expiring') AND end_date <= $2`,
      [cid, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)]
    );
    const queuedCalls = await q(
      "SELECT count(*)::int AS n FROM payer_call_queue WHERE clinic_id = $1 AND status = 'queued'",
      [cid]
    );
    const claims = await q(
      `SELECT c.*, p.initials AS patient_initials FROM claims c
        JOIN patients p ON p.id = c.patient_id
       WHERE c.clinic_id = $1 ORDER BY c.date_of_service DESC LIMIT 20`,
      [cid]
    );
    const arRows = await q(
      `SELECT c.*, p.initials AS patient_initials FROM claims c
        JOIN patients p ON p.id = c.patient_id
       WHERE c.clinic_id = $1 AND c.status IN ('submitted', 'partial', 'denied')
       ORDER BY c.date_of_service ASC`,
      [cid]
    );
    const auths = await q(
      `SELECT a.*, p.initials AS patient_initials FROM authorizations a
        JOIN patients p ON p.id = a.patient_id
       WHERE a.clinic_id = $1 AND a.status IN ('active', 'expiring') AND a.end_date <= $2
       ORDER BY a.end_date ASC`,
      [cid, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)]
    );
    const denialAlerts = await q(
      `SELECT d.*, c.date_of_service FROM denials d JOIN claims c ON c.id = d.claim_id
        WHERE d.clinic_id = $1 AND d.status = 'open' AND d.appeal_deadline <= $2
       ORDER BY d.appeal_deadline ASC`,
      [cid, new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)]
    );

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const arItems = arRows.map((r) => {
      const balance = toMoney(r.billed_amount) - toMoney(r.paid_amount);
      const ageDays = Math.floor((today.getTime() - new Date(isoDate(r.date_of_service)).getTime()) / 86400000);
      return cleanRow({ ...r, balance, age_days: ageDays }, ['billed_amount', 'paid_amount', 'balance'], ['date_of_service']);
    });

    res.json({
      ok: true,
      portal: {
        clinic: cleanRow(clinic, [], ['trial_ends_at']),
        dashboard: {
          recoveredThisMonth: toMoney(recovered[0].total),
          paidClaimsThisMonth: recovered[0].n,
          openAr: toMoney(openAr[0].total),
          openArClaims: openAr[0].n,
          openDenials: openDenials[0].n,
          authsExpiring30d: expiring[0].n,
          queuedCalls: queuedCalls[0].n,
        },
        subscription: {
          status: clinic.subscription_status,
          plan: clinic.subscription_plan,
          trialEndsAt: clinic.trial_ends_at ? isoDate(clinic.trial_ends_at) : null,
          priceMonthly: 500,
        },
        claims: claims.map((c) => cleanRow(c, ['billed_amount', 'paid_amount'], ['date_of_service'])),
        ar: arItems,
        alerts: {
          authExpiries: auths.map((a) => cleanRow({
            ...a,
            days_left: daysUntil(a.end_date),
            units_remaining: (a.total_units || 0) - (a.units_used || 0),
          }, [], ['start_date', 'end_date'])),
          appealDeadlines: denialAlerts.map((d) => cleanRow({
            ...d, days_left: daysUntil(d.appeal_deadline),
          }, [], ['appeal_deadline', 'date_of_service'])),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
