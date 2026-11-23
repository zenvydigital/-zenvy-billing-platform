'use strict';

/**
 * Integrations (Pass 4): vendor connections + EDI.
 *
 *   GET  /api/integrations
 *        — the 7 vendors, their mode, and the exact authorization steps
 *          the clinic must complete before live is even possible.
 *   POST /api/integrations/:vendor/mode { mode }
 *        — Zenvy owner only. 'off' / 'simulation' allowed; 'live' is
 *          REFUSED, always (see src/integrations.js).
 *
 * Clinic-scoped EDI (mounted under /api/clinics/:clinicId in index.js):
 *   GET  /edi/batches
 *        — 837 clearinghouse batches (grouped submitted claims).
 *   POST /claims/:id/status-check
 *        — EDI 276/277 claim status check (simulation): a paid claim
 *          answers "paid in full", a submitted claim "in process",
 *          a denied claim "denied". Refs are stored on the claim.
 * 270/271 refs live on verifications (edi_270_ref / edi_271_ref) and
 * 835 ERA import is the ERA tab — both are listed on this page too.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, toMoney, isoDate } = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { VENDORS, VENDOR_ORDER, setConnectionMode } = require('../integrations');

// ------------------------------------------------------- platform-level

const platform = express.Router();
platform.use(requireAuth);

platform.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM connections ORDER BY vendor');
    const byVendor = new Map(rows.map((r) => [r.vendor, r]));
    const vendors = VENDOR_ORDER.map((key) => {
      const row = byVendor.get(key);
      const meta = VENDORS[key];
      return {
        vendor: key,
        label: meta.label,
        kind: meta.kind,
        what: meta.what,
        edi: meta.edi,
        steps: meta.steps,
        mode: row ? row.mode : 'simulation',
        simulation: row ? row.mode !== 'live' : true,
      };
    });
    res.json({
      ok: true,
      integrations: vendors,
      simulation: true,
      note: 'Everything runs in Simulation mode until the real vendor account, credentials and approvals exist. A connection is never shown as live when it is not.',
    });
  } catch (err) {
    next(err);
  }
});

platform.post('/:vendor/mode', async (req, res, next) => {
  try {
    // Only the Zenvy platform owner changes vendor modes.
    if (req.user.role !== 'owner' || req.user.clinic_id !== null) {
      throw new ApiError(403, 'Only the Zenvy platform owner can change vendor connections.');
    }
    const row = await setConnectionMode(query, req.params.vendor, req.body.mode, req.user);
    res.json({
      ok: true,
      vendor: row.vendor,
      mode: row.mode,
      simulation: row.mode !== 'live',
      note: row.mode === 'live'
        ? 'Live.'
        : 'Simulation mode — no live vendor data is sent or received.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- clinic-scoped

const clinic = express.Router({ mergeParams: true });
clinic.use(requireAuth, loadClinic);

/** 837 batches: submitted claims grouped by clearinghouse batch ref. */
clinic.get('/edi/batches', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT clearinghouse_batch_ref, count(*)::int AS claim_count,
              COALESCE(SUM(billed_amount), 0) AS total_billed,
              COALESCE(SUM(paid_amount), 0) AS total_paid,
              MIN(created_at) AS first_claim
         FROM claims
        WHERE clinic_id = $1 AND clearinghouse_batch_ref IS NOT NULL
        GROUP BY clearinghouse_batch_ref
        ORDER BY first_claim DESC`,
      [req.clinic.id]
    );
    const batches = await Promise.all(rows.map(async (b) => {
      const claims = await query(
        'SELECT id, payer_claim_number, date_of_service, cpt_code, billed_amount, status FROM claims WHERE clinic_id = $1 AND clearinghouse_batch_ref = $2 ORDER BY date_of_service',
        [req.clinic.id, b.clearinghouse_batch_ref]
      );
      return {
        batchRef: b.clearinghouse_batch_ref,
        claimCount: b.claim_count,
        totalBilled: toMoney(b.total_billed),
        totalPaid: toMoney(b.total_paid),
        simulation: true,
        claims: claims.rows.map((c) => cleanRow(c, ['billed_amount'], ['date_of_service'])),
      };
    }));
    res.json({ ok: true, batches, simulation: true, note: 'Simulation mode — batches were accepted by the built-in simulator, not a real clearinghouse.' });
  } catch (err) {
    next(err);
  }
});

/**
 * EDI 276/277 claim status check (simulation).
 * A claim must be submitted (or further along) to check. The 277
 * answer mirrors what the claim already says — this check reports
 * status, it never invents a payment.
 */
clinic.post('/claims/:id/status-check', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    if (claim.status === 'draft' || claim.status === 'ready') {
      throw new ApiError(409, 'This claim has not been submitted yet — submit it first, then check its status.');
    }
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    const ref276 = `EDI-276-SIM-${tag}`;
    const ref277 = `EDI-277-SIM-${tag}`;
    let answer;
    if (claim.status === 'paid') {
      answer = {
        status: 'paid',
        paidAmount: toMoney(claim.billed_amount),
        message: `Paid in full — $${toMoney(claim.billed_amount).toFixed(2)} (the full billed amount).`,
      };
    } else if (claim.status === 'partial') {
      answer = {
        status: 'partial',
        paidAmount: toMoney(claim.paid_amount),
        message: `Partially paid — $${toMoney(claim.paid_amount).toFixed(2)} of $${toMoney(claim.billed_amount).toFixed(2)} posted.`,
      };
    } else if (claim.status === 'denied') {
      const d = await query('SELECT denial_code FROM denials WHERE claim_id = $1 ORDER BY created_at DESC LIMIT 1', [claim.id]);
      answer = {
        status: 'denied',
        denialCode: d.rows.length > 0 ? d.rows[0].denial_code : null,
        message: 'Denied by the payer — see the denial record and appeal it from the Denials tab.',
      };
    } else {
      answer = {
        status: 'in-process',
        message: 'The payer has the claim and it is still being processed — no payment posted yet.',
      };
    }
    const updated = await query(
      'UPDATE claims SET edi_276_ref = $1, edi_277_ref = $2, updated_at = now() WHERE id = $3 RETURNING *',
      [ref276, ref277, claim.id]
    );
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'edi-status-check',
      detail: { edi_276_ref: ref276, edi_277_ref: ref277, status: answer.status, simulation: true },
    });
    res.json({
      ok: true,
      simulation: true,
      simulationNote: 'Simulation mode — no real clearinghouse was contacted. The 277 answer mirrors the claim’s recorded status.',
      edi276Ref: ref276,
      edi277Ref: ref277,
      claim: cleanRow(updated.rows[0], ['billed_amount', 'paid_amount'], ['date_of_service']),
      answer,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { platform, clinic };
