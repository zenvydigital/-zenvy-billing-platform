'use strict';

/**
 * ERA / payment posting.
 *
 * ERA lines are FINANCIAL RECORDS: there is no delete path, ever — not
 * even for demo data (the demo loader therefore never creates ERA lines).
 *
 * Import auto-match, in order:
 *   1. payer claim number → a submitted/partial/denied claim
 *   2. patient initials + date of service + CPT → a claim
 * Anything else stays 'unmatched' and can be matched by hand.
 * Posting applies the paid amount to the claim (paid / partial).
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, toMoney, isoDate } = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

function cleanEra(e) {
  return cleanRow(e, ['paid_amount'], ['date_of_service']);
}

router.get('/era', async (req, res, next) => {
  try {
    let sql = 'SELECT * FROM era_lines WHERE clinic_id = $1';
    const params = [req.clinic.id];
    if (req.query.status) {
      sql += ' AND status = $2';
      params.push(req.query.status);
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query(sql, params);
    res.json({ ok: true, era: rows.map(cleanEra) });
  } catch (err) {
    next(err);
  }
});

async function autoMatch(clinicId, line) {
  // 1. Payer claim number.
  if (line.payer_claim_number) {
    const byNumber = await query(
      `SELECT id FROM claims WHERE clinic_id = $1 AND payer_claim_number = $2
        AND status IN ('submitted', 'partial', 'denied') LIMIT 1`,
      [clinicId, line.payer_claim_number]
    );
    if (byNumber.rows.length > 0) return byNumber.rows[0].id;
  }
  // 2. Patient initials + date of service + CPT.
  if (line.patient_initials && line.date_of_service && line.cpt_code) {
    const byDetails = await query(
      `SELECT c.id FROM claims c JOIN patients p ON p.id = c.patient_id
        WHERE c.clinic_id = $1 AND p.initials = $2 AND c.date_of_service = $3 AND c.cpt_code = $4
          AND c.status IN ('submitted', 'partial', 'denied') LIMIT 1`,
      [clinicId, line.patient_initials, line.date_of_service, line.cpt_code]
    );
    if (byDetails.rows.length > 0) return byDetails.rows[0].id;
  }
  return null;
}

/** Import ERA lines (JSON rows). Each row is auto-matched or stored unmatched. */
router.post('/era/import', requireWrite, async (req, res, next) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, 'Send ERA rows as a JSON array (payer_claim_number, patient_initials, date_of_service, cpt_code, paid_amount).');
    }
    const imported = [];
    for (const r of rows) {
      const paid = toMoney(r.paid_amount);
      if (!(paid >= 0)) continue;
      const line = {
        payer_claim_number: r.payer_claim_number || null,
        patient_initials: r.patient_initials || null,
        date_of_service: r.date_of_service || null,
        cpt_code: r.cpt_code || null,
        paid_amount: paid,
        raw_ref: r.raw_ref || null,
      };
      const claimId = await autoMatch(req.clinic.id, line);
      const ins = await query(
        `INSERT INTO era_lines (clinic_id, claim_id, payer_claim_number, patient_initials, date_of_service, cpt_code, paid_amount, status, raw_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          req.clinic.id, claimId, line.payer_claim_number, line.patient_initials,
          line.date_of_service, line.cpt_code, paid,
          claimId ? 'matched' : 'unmatched', line.raw_ref,
        ]
      );
      imported.push(cleanEra(ins.rows[0]));
    }
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'era', entityId: null, action: 'import',
      detail: { rows: imported.length, matched: imported.filter((l) => l.status === 'matched').length, unmatched: imported.filter((l) => l.status === 'unmatched').length },
    });
    res.status(201).json({
      ok: true,
      imported,
      summary: {
        total: imported.length,
        matched: imported.filter((l) => l.status === 'matched').length,
        unmatched: imported.filter((l) => l.status === 'unmatched').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Manually match an unmatched ERA line to a claim. */
router.post('/era/:id/match', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM era_lines WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'ERA line not found.');
    const line = rows[0];
    if (line.status === 'posted') throw new ApiError(409, 'This ERA line is already posted — posted lines cannot be changed.');
    const { rows: claimRows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.body.claim_id, req.clinic.id]);
    if (claimRows.length === 0) throw new ApiError(404, 'Claim not found in this clinic.');
    const updated = await query(
      "UPDATE era_lines SET claim_id = $1, status = 'matched' WHERE id = $2 RETURNING *",
      [claimRows[0].id, line.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'era', entityId: line.id, action: 'match', detail: { claim_id: claimRows[0].id } });
    res.json({ ok: true, era: cleanEra(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** Post a matched ERA line: apply its payment to the claim. */
router.post('/era/:id/post', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM era_lines WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'ERA line not found.');
    const line = rows[0];
    if (line.status === 'posted') throw new ApiError(409, 'This ERA line is already posted.');
    if (!line.claim_id) {
      throw new ApiError(409, 'This ERA line is unmatched — match it to a claim first (or leave it unmatched).');
    }
    const { rows: claimRows } = await query('SELECT * FROM claims WHERE id = $1', [line.claim_id]);
    if (claimRows.length === 0) throw new ApiError(404, 'The matched claim no longer exists.');
    const claim = claimRows[0];
    const newPaid = toMoney(claim.paid_amount) + toMoney(line.paid_amount);
    const newStatus = newPaid >= toMoney(claim.billed_amount) ? 'paid' : 'partial';
    await query("UPDATE claims SET paid_amount = $1, status = $2, updated_at = now() WHERE id = $3", [newPaid, newStatus, claim.id]);
    const updated = await query("UPDATE era_lines SET status = 'posted' WHERE id = $1 RETURNING *", [line.id]);
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'era', entityId: line.id, action: 'post',
      detail: { claim_id: claim.id, amount: toMoney(line.paid_amount), claim_status: newStatus },
    });
    res.json({ ok: true, era: cleanEra(updated.rows[0]), claimStatus: newStatus, claimPaid: newPaid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
