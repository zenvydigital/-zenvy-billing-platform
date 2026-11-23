'use strict';

/**
 * Billing: verifications, authorizations, sessions, claims, denials,
 * payer calls + queue.
 *
 * Hard rules:
 *   - Scrub gate: a claim CANNOT be submitted until scrub passes.
 *   - Clearinghouse submit is SIMULATION until a live account exists
 *     (batch refs + payer claim numbers are labelled SIM-*).
 *   - Payer-call queue is OPT-IN only — a clinic that has not enabled
 *     payer calls gets a plain refusal, server-enforced.
 *   - A logged call outcome updates the claim (paid → claim paid +
 *     open denials resolved; denied → claim denied + denial recorded).
 *   - Deletes unlink (claim delete unlinks its session; auth delete
 *     unlinks its sessions) and show plain messages, never raw SQL.
 */

const express = require('express');
const { query } = require('../db');
const {
  ApiError, cleanRow, applyMerge, isValidCpt, toMoney, toInt, isoDate, daysUntil,
} = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { runScrub } = require('../scrub');
const { scoreClaim } = require('../risk');
const { applyCallOutcome, OUTCOMES } = require('../calls');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

async function getPatientInClinic(clinicId, patientId) {
  const { rows } = await query('SELECT * FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, clinicId]);
  return rows[0] || null;
}

async function mustOwnPatient(req, patientId) {
  const p = await getPatientInClinic(req.clinic.id, patientId);
  if (!p) throw new ApiError(404, 'Patient not found in this clinic.');
  return p;
}

function cleanClaim(c) {
  return cleanRow(c, ['billed_amount', 'paid_amount'], ['date_of_service']);
}

// ----------------------------------------------------------- verifications

router.get('/verifications', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT v.*, p.initials AS patient_initials FROM verifications v
        JOIN patients p ON p.id = v.patient_id
       WHERE v.clinic_id = $1 ORDER BY v.created_at DESC`,
      [req.clinic.id]
    );
    res.json({ ok: true, verifications: rows.map((r) => cleanRow(r, [], ['coverage_start', 'coverage_end'])) });
  } catch (err) {
    next(err);
  }
});

router.post('/verifications', requireWrite, async (req, res, next) => {
  try {
    const patient = await mustOwnPatient(req, req.body.patient_id);
    if (req.body.status !== undefined && !['pending', 'eligible', 'ineligible'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be pending, eligible or ineligible.');
    }
    const ins = await query(
      `INSERT INTO verifications (clinic_id, patient_id, payer, status, coverage_start, coverage_end, notes, edi_270_ref, edi_271_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.clinic.id, patient.id, req.body.payer || patient.payer || null,
        req.body.status || 'pending', req.body.coverage_start || null,
        req.body.coverage_end || null, req.body.notes || null,
        req.body.edi_270_ref || null, req.body.edi_271_ref || null,
      ]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'verification', entityId: ins.rows[0].id, action: 'create', detail: { patient: patient.initials, status: ins.rows[0].status } });
    res.status(201).json({ ok: true, verification: cleanRow(ins.rows[0], [], ['coverage_start', 'coverage_end']) });
  } catch (err) {
    next(err);
  }
});

router.patch('/verifications/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM verifications WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Verification not found.');
    if (req.body.status !== undefined && !['pending', 'eligible', 'ineligible'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be pending, eligible or ineligible.');
    }
    const updated = await applyMerge(query, 'verifications', rows[0], ['payer', 'status', 'coverage_start', 'coverage_end', 'notes', 'edi_270_ref', 'edi_271_ref'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'verification', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, verification: cleanRow(updated, [], ['coverage_start', 'coverage_end']) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- authorizations

router.get('/authorizations', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.*, p.initials AS patient_initials FROM authorizations a
        JOIN patients p ON p.id = a.patient_id
       WHERE a.clinic_id = $1 ORDER BY a.end_date ASC NULLS LAST`,
      [req.clinic.id]
    );
    res.json({
      ok: true,
      authorizations: rows.map((a) => cleanRow({
        ...a,
        days_left: daysUntil(a.end_date),
        units_remaining: (a.total_units || 0) - (a.units_used || 0),
      }, [], ['start_date', 'end_date'])),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/authorizations', requireWrite, async (req, res, next) => {
  try {
    const patient = await mustOwnPatient(req, req.body.patient_id);
    const authNumber = String(req.body.auth_number || '').trim();
    if (!authNumber) throw new ApiError(400, 'Authorization number is required.');
    const cpts = String(req.body.cpt_codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const c of cpts) {
      if (!isValidCpt(c)) throw new ApiError(400, `CPT ${c} is not a valid ABA code (97151–97158).`);
    }
    let auth;
    try {
      const ins = await query(
        `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          req.clinic.id, patient.id, authNumber, req.body.payer || patient.payer || null,
          cpts.join(',') || null, toInt(req.body.total_units, 0), toInt(req.body.units_used, 0),
          req.body.start_date || null, req.body.end_date || null,
        ]
      );
      auth = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') throw new ApiError(400, `Authorization ${authNumber} already exists in this clinic.`);
      throw err;
    }
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'authorization', entityId: auth.id, action: 'create', detail: { auth_number: authNumber, patient: patient.initials } });
    res.status(201).json({ ok: true, authorization: cleanRow(auth, [], ['start_date', 'end_date']) });
  } catch (err) {
    next(err);
  }
});

router.patch('/authorizations/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM authorizations WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Authorization not found.');
    if (req.body.cpt_codes !== undefined) {
      for (const c of String(req.body.cpt_codes).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!isValidCpt(c)) throw new ApiError(400, `CPT ${c} is not a valid ABA code (97151–97158).`);
      }
    }
    if (req.body.status !== undefined && !['active', 'expiring', 'expired', 'exhausted'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be active, expiring, expired or exhausted.');
    }
    const updated = await applyMerge(query, 'authorizations', rows[0], ['auth_number', 'payer', 'cpt_codes', 'total_units', 'units_used', 'start_date', 'end_date', 'status'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'authorization', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, authorization: cleanRow(updated, [], ['start_date', 'end_date']) });
  } catch (err) {
    next(err);
  }
});

/** Delete an authorization — its sessions are unlinked (kept, no auth). */
router.delete('/authorizations/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM authorizations WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Authorization not found.');
    const linked = await query('SELECT count(*)::int AS n FROM sessions WHERE authorization_id = $1', [rows[0].id]);
    await query('DELETE FROM authorizations WHERE id = $1', [rows[0].id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'authorization', entityId: rows[0].id, action: 'delete', detail: { auth_number: rows[0].auth_number, sessions_unlinked: linked.rows[0].n } });
    res.json({ ok: true, deleted: true, sessionsUnlinked: linked.rows[0].n });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- sessions

router.get('/sessions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, p.initials AS patient_initials FROM sessions s
        JOIN patients p ON p.id = s.patient_id
       WHERE s.clinic_id = $1 ORDER BY s.session_date DESC`,
      [req.clinic.id]
    );
    res.json({ ok: true, sessions: rows.map((r) => cleanRow(r, [], ['session_date'])) });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions', requireWrite, async (req, res, next) => {
  try {
    const patient = await mustOwnPatient(req, req.body.patient_id);
    if (!isValidCpt(req.body.cpt_code)) throw new ApiError(400, 'CPT code must be a valid ABA code (97151–97158).');
    if (!req.body.session_date) throw new ApiError(400, 'Session date is required.');
    let authId = null;
    if (req.body.authorization_id) {
      const a = await query('SELECT id FROM authorizations WHERE id = $1 AND clinic_id = $2', [req.body.authorization_id, req.clinic.id]);
      if (a.rows.length === 0) throw new ApiError(400, 'That authorization does not exist in this clinic.');
      authId = a.rows[0].id;
    }
    const ins = await query(
      `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.clinic.id, patient.id, authId, req.body.session_date, req.body.cpt_code,
        toInt(req.body.units, 0), req.body.duration_min ? toInt(req.body.duration_min) : null,
        req.body.status || 'scheduled', req.body.notes || null,
      ]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'session', entityId: ins.rows[0].id, action: 'create', detail: { patient: patient.initials, cpt_code: req.body.cpt_code } });
    res.status(201).json({ ok: true, session: cleanRow(ins.rows[0], [], ['session_date']) });
  } catch (err) {
    next(err);
  }
});

router.patch('/sessions/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM sessions WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Session not found.');
    if (req.body.cpt_code !== undefined && !isValidCpt(req.body.cpt_code)) {
      throw new ApiError(400, 'CPT code must be a valid ABA code (97151–97158).');
    }
    if (req.body.status !== undefined && !['scheduled', 'completed', 'cancelled', 'billed'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be scheduled, completed, cancelled or billed.');
    }
    const updated = await applyMerge(query, 'sessions', rows[0], ['session_date', 'cpt_code', 'units', 'duration_min', 'status', 'notes', 'authorization_id'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'session', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, session: cleanRow(updated, [], ['session_date']) });
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM sessions WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Session not found.');
    if (rows[0].claim_id) {
      throw new ApiError(409, 'This session already has a claim — delete the claim first if the session must go.');
    }
    await query('DELETE FROM sessions WHERE id = $1', [req.params.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'session', entityId: Number(req.params.id), action: 'delete', detail: {} });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

/** Completed session → draft claim, in one tap. */
router.post('/sessions/:id/create-claim', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM sessions WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Session not found.');
    const session = rows[0];
    if (session.status !== 'completed') {
      throw new ApiError(409, 'Only a completed session can become a claim — mark the session completed first.');
    }
    if (session.claim_id) {
      throw new ApiError(409, 'This session already has a claim.');
    }
    const ins = await query(
      `INSERT INTO claims (clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'draft') RETURNING *`,
      [req.clinic.id, session.patient_id, session.authorization_id, session.id, isoDate(session.session_date), session.cpt_code, session.units]
    );
    const claim = ins.rows[0];
    await query("UPDATE sessions SET claim_id = $1, status = 'billed', updated_at = now() WHERE id = $2", [claim.id, session.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'create', detail: { from_session: session.id, cpt_code: session.cpt_code } });
    res.status(201).json({ ok: true, claim: cleanClaim(claim), simulation: false });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- claims

router.get('/claims', async (req, res, next) => {
  try {
    let sql = `SELECT c.*, p.initials AS patient_initials FROM claims c
                 JOIN patients p ON p.id = c.patient_id
                WHERE c.clinic_id = $1`;
    const params = [req.clinic.id];
    if (req.query.status) {
      sql += ' AND c.status = $2';
      params.push(req.query.status);
    }
    sql += ' ORDER BY c.date_of_service DESC';
    const { rows } = await query(sql, params);
    res.json({ ok: true, claims: rows.map(cleanClaim) });
  } catch (err) {
    next(err);
  }
});

router.post('/claims', requireWrite, async (req, res, next) => {
  try {
    const patient = await mustOwnPatient(req, req.body.patient_id);
    if (!isValidCpt(req.body.cpt_code)) throw new ApiError(400, 'CPT code must be a valid ABA code (97151–97158).');
    if (!req.body.date_of_service) throw new ApiError(400, 'Date of service is required.');
    let authId = null;
    if (req.body.authorization_id) {
      const a = await query('SELECT id FROM authorizations WHERE id = $1 AND clinic_id = $2', [req.body.authorization_id, req.clinic.id]);
      if (a.rows.length === 0) throw new ApiError(400, 'That authorization does not exist in this clinic.');
      authId = a.rows[0].id;
    }
    const ins = await query(
      `INSERT INTO claims (clinic_id, patient_id, authorization_id, date_of_service, cpt_code, units, billed_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.clinic.id, patient.id, authId, req.body.date_of_service, req.body.cpt_code,
        toInt(req.body.units, 0), toMoney(req.body.billed_amount), req.body.notes || null,
      ]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: ins.rows[0].id, action: 'create', detail: { patient: patient.initials, cpt_code: req.body.cpt_code } });
    res.status(201).json({ ok: true, claim: cleanClaim(ins.rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.get('/claims/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, p.initials AS patient_initials FROM claims c
        JOIN patients p ON p.id = c.patient_id
       WHERE c.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    res.json({ ok: true, claim: cleanClaim(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.patch('/claims/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    if (req.body.cpt_code !== undefined && !isValidCpt(req.body.cpt_code)) {
      throw new ApiError(400, 'CPT code must be a valid ABA code (97151–97158).');
    }
    if (req.body.status !== undefined) {
      throw new ApiError(400, 'Change claim status through scrub / submit / payment actions, not by editing it directly.');
    }
    if (req.body.billed_amount !== undefined) req.body.billed_amount = toMoney(req.body.billed_amount);
    if (req.body.paid_amount !== undefined) req.body.paid_amount = toMoney(req.body.paid_amount);
    if (req.body.units !== undefined) req.body.units = toInt(req.body.units, 0);
    const updated = await applyMerge(query, 'claims', rows[0], ['authorization_id', 'session_id', 'date_of_service', 'cpt_code', 'units', 'billed_amount', 'paid_amount', 'notes'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, claim: cleanClaim(updated) });
  } catch (err) {
    next(err);
  }
});

/** Delete a claim — its session is unlinked (kept, can be billed again). */
router.delete('/claims/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    const blocking = [];
    const den = await query('SELECT count(*)::int AS n FROM denials WHERE claim_id = $1', [claim.id]);
    if (den.rows[0].n > 0) blocking.push(`${den.rows[0].n} denial record(s)`);
    const calls = await query('SELECT count(*)::int AS n FROM payer_calls WHERE claim_id = $1', [claim.id]);
    if (calls.rows[0].n > 0) blocking.push(`${calls.rows[0].n} payer call log(s)`);
    if (blocking.length > 0) {
      throw new ApiError(409, `This claim cannot be deleted — it still has ${blocking.join(' and ')}. Those records are kept for the clinic's history.`);
    }
    await query('DELETE FROM claims WHERE id = $1', [claim.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'delete', detail: { cpt_code: claim.cpt_code, date_of_service: isoDate(claim.date_of_service) } });
    res.json({ ok: true, deleted: true, note: 'Any linked session was unlinked and can be billed again.' });
  } catch (err) {
    next(err);
  }
});

/** Copy a claim as a fresh draft (for re-bills). */
router.post('/claims/:id/duplicate', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const src = rows[0];
    const ins = await query(
      `INSERT INTO claims (clinic_id, patient_id, authorization_id, date_of_service, cpt_code, units, billed_amount, notes, status, scrub_status, scrub_errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', 'not-run', '[]') RETURNING *`,
      [req.clinic.id, src.patient_id, src.authorization_id, isoDate(src.date_of_service), src.cpt_code, src.units, src.billed_amount, src.notes]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: ins.rows[0].id, action: 'duplicate', detail: { from_claim: src.id } });
    res.status(201).json({ ok: true, claim: cleanClaim(ins.rows[0]) });
  } catch (err) {
    next(err);
  }
});

/** Run the scrubber on a claim. A pass moves a draft to 'ready'. */
router.post('/claims/:id/scrub', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    const result = await runScrub(query, req.clinic.id, claim);
    const nextStatus = result.passed && claim.status === 'draft' ? 'ready' : claim.status;
    const updated = await query(
      `UPDATE claims SET scrub_status = $1, scrub_errors = $2, status = $3, updated_at = now()
        WHERE id = $4 RETURNING *`,
      [result.passed ? 'passed' : 'failed', JSON.stringify(result.errors), nextStatus, claim.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'scrub', detail: { passed: result.passed, errors: result.errors.length } });
    res.json({ ok: true, claim: cleanClaim(updated.rows[0]), scrub: result });
  } catch (err) {
    next(err);
  }
});

/** Denial-risk score (Pass 4): rule-based 0–100 with named factors. */
router.post('/claims/:id/risk', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    const risk = await scoreClaim(query, req.clinic.id, claim);
    const updated = await query(
      'UPDATE claims SET risk_score = $1, risk_factors = $2, updated_at = now() WHERE id = $3 RETURNING *',
      [risk.score, JSON.stringify(risk.factors), claim.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'risk-score', detail: { score: risk.score, band: risk.band, factors: risk.factors.length } });
    res.json({ ok: true, claim: cleanClaim(updated.rows[0]), risk });
  } catch (err) {
    next(err);
  }
});

/**
 * Submit to the clearinghouse. SCRUB GATE: a claim that has not passed the
 * scrubber cannot be submitted. Simulation mode until a live clearinghouse
 * account exists — batch refs and payer claim numbers are labelled SIM-*.
 */
router.post('/claims/:id/submit', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    if (claim.status === 'submitted' || claim.status === 'paid') {
      throw new ApiError(409, `This claim is already ${claim.status}.`);
    }
    const result = await runScrub(query, req.clinic.id, claim);
    if (!result.passed) {
      await query(
        `UPDATE claims SET scrub_status = 'failed', scrub_errors = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify(result.errors), claim.id]
      );
      throw new ApiError(409, `This claim cannot be submitted — it failed the scrub check: ${result.errors.filter((e) => e.severity === 'error').map((e) => e.message).join(' ')}`);
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const batchRef = `SIM-BATCH-${stamp}-${String(Math.floor(Math.random() * 900) + 100)}`;
    const payerNumber = `SIM-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const updated = await query(
      `UPDATE claims SET scrub_status = 'passed', scrub_errors = $1, status = 'submitted',
        clearinghouse_batch_ref = $2, payer_claim_number = $3, updated_at = now()
        WHERE id = $4 RETURNING *`,
      [JSON.stringify(result.errors), batchRef, payerNumber, claim.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'submit', detail: { batch_ref: batchRef, payer_claim_number: payerNumber, simulation: true } });
    res.json({
      ok: true,
      claim: cleanClaim(updated.rows[0]),
      simulation: true,
      simulationNote: 'Simulation mode — no real clearinghouse connection yet. The batch was accepted by the built-in simulator.',
    });
  } catch (err) {
    next(err);
  }
});

/** Record a payment against a claim (ERA posting does this too). */
router.post('/claims/:id/record-payment', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Claim not found.');
    const claim = rows[0];
    const amount = toMoney(req.body.amount);
    if (!(amount > 0)) throw new ApiError(400, 'Payment amount must be greater than $0.');
    const newPaid = toMoney(claim.paid_amount) + amount;
    const newStatus = newPaid >= toMoney(claim.billed_amount) ? 'paid' : 'partial';
    const updated = await query(
      `UPDATE claims SET paid_amount = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [newPaid, newStatus, claim.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'claim', entityId: claim.id, action: 'payment', detail: { amount, status: newStatus } });
    res.json({ ok: true, claim: cleanClaim(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ denials

router.get('/denials', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, p.initials AS patient_initials, c.date_of_service, c.cpt_code, c.billed_amount
         FROM denials d
         JOIN patients p ON p.id = d.patient_id
         JOIN claims c ON c.id = d.claim_id
        WHERE d.clinic_id = $1 ORDER BY d.appeal_deadline ASC NULLS LAST`,
      [req.clinic.id]
    );
    res.json({ ok: true, denials: rows.map((r) => cleanRow(r, ['billed_amount'], ['appeal_deadline', 'date_of_service'])) });
  } catch (err) {
    next(err);
  }
});

router.post('/denials', requireWrite, async (req, res, next) => {
  try {
    const { rows: claimRows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.body.claim_id, req.clinic.id]);
    if (claimRows.length === 0) throw new ApiError(404, 'Claim not found in this clinic.');
    const claim = claimRows[0];
    const ins = await query(
      `INSERT INTO denials (clinic_id, claim_id, patient_id, denial_code, reason, appeal_deadline, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.clinic.id, claim.id, claim.patient_id,
        req.body.denial_code || null, req.body.reason || null,
        req.body.appeal_deadline || null, req.body.notes || null,
      ]
    );
    await query("UPDATE claims SET status = 'denied', updated_at = now() WHERE id = $1", [claim.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'denial', entityId: ins.rows[0].id, action: 'create', detail: { claim_id: claim.id, denial_code: req.body.denial_code } });
    res.status(201).json({ ok: true, denial: cleanRow(ins.rows[0], [], ['appeal_deadline']) });
  } catch (err) {
    next(err);
  }
});

router.patch('/denials/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM denials WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Denial not found.');
    if (req.body.status !== undefined && !['open', 'appealing', 'appealed', 'written-off'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be open, appealing, appealed or written-off.');
    }
    const updated = await applyMerge(query, 'denials', rows[0], ['denial_code', 'reason', 'status', 'appeal_deadline', 'notes'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'denial', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, denial: cleanRow(updated, [], ['appeal_deadline']) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- payer calls + queue

function requirePayerOptIn(clinic) {
  if (!clinic.payer_calls_opt_in) {
    throw new ApiError(
      403,
      'Payer calls are not enabled for this clinic. The clinic owner must turn on payer calls (opt-in) before Sara or the team can call payers for it.'
    );
  }
}

router.get('/call-queue', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT q.*, p.initials AS patient_initials, c.date_of_service, c.cpt_code, c.billed_amount, c.status AS claim_status
         FROM payer_call_queue q
         JOIN claims c ON c.id = q.claim_id
         JOIN patients p ON p.id = c.patient_id
        WHERE q.clinic_id = $1 ORDER BY q.created_at ASC`,
      [req.clinic.id]
    );
    res.json({ ok: true, queue: rows.map((r) => cleanRow(r, ['billed_amount'], ['date_of_service'])) });
  } catch (err) {
    next(err);
  }
});

router.post('/call-queue', requireWrite, async (req, res, next) => {
  try {
    requirePayerOptIn(req.clinic);
    const { rows: claimRows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.body.claim_id, req.clinic.id]);
    if (claimRows.length === 0) throw new ApiError(404, 'Claim not found in this clinic.');
    const question = String(req.body.question || '').trim();
    if (!question) throw new ApiError(400, 'The exact question to ask the payer is required.');
    const ins = await query(
      `INSERT INTO payer_call_queue (clinic_id, claim_id, question) VALUES ($1, $2, $3) RETURNING *`,
      [req.clinic.id, claimRows[0].id, question]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'payer_call_queue', entityId: ins.rows[0].id, action: 'create', detail: { claim_id: claimRows[0].id } });
    res.status(201).json({ ok: true, queueItem: cleanRow(ins.rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post('/call-queue/:id/cancel', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM payer_call_queue WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Queue item not found.');
    const updated = await query("UPDATE payer_call_queue SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *", [req.params.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'payer_call_queue', entityId: Number(req.params.id), action: 'cancel', detail: {} });
    res.json({ ok: true, queueItem: cleanRow(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.get('/payer-calls', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT pc.*, p.initials AS patient_initials, c.date_of_service, c.cpt_code
         FROM payer_calls pc
         JOIN claims c ON c.id = pc.claim_id
         JOIN patients p ON p.id = c.patient_id
        WHERE pc.clinic_id = $1 ORDER BY pc.called_at DESC`,
      [req.clinic.id]
    );
    res.json({ ok: true, calls: rows.map((r) => cleanRow(r, [], ['date_of_service'])) });
  } catch (err) {
    next(err);
  }
});

/**
 * Log a payer call. The outcome updates the claim:
 *   paid   → claim paid (+ open denials resolved)
 *   denied → claim denied + denial recorded
 *   other  → logged only, claim keeps its status
 */
router.post('/payer-calls', requireWrite, async (req, res, next) => {
  try {
    requirePayerOptIn(req.clinic);
    const { rows: claimRows } = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [req.body.claim_id, req.clinic.id]);
    if (claimRows.length === 0) throw new ApiError(404, 'Claim not found in this clinic.');
    const claim = claimRows[0];
    const outcome = String(req.body.outcome || '').trim();
    if (!OUTCOMES.includes(outcome)) {
      throw new ApiError(400, 'Outcome must be paid, denied, partial, pending or info-received.');
    }
    if (req.body.caller !== undefined && !['sara', 'team'].includes(req.body.caller)) {
      throw new ApiError(400, 'Caller must be sara or team.');
    }
    let queueId = null;
    if (req.body.queue_id) {
      const q = await query('SELECT id FROM payer_call_queue WHERE id = $1 AND clinic_id = $2', [req.body.queue_id, req.clinic.id]);
      if (q.rows.length > 0) queueId = q.rows[0].id;
    }
    // Outcome rules live in src/calls.js (shared with the Sara dialer
    // bridge) — paid → claim paid + open denials resolved; denied →
    // claim denied + denial recorded; anything else is logged only.
    const { call, claim: updatedClaim } = await applyCallOutcome(query, req.clinic.id, claim, {
      caller: req.body.caller || 'team',
      outcome,
      statusAnswer: req.body.status_answer || null,
      referenceNumber: req.body.reference_number || null,
      nextAction: req.body.next_action || null,
      amountPaid: req.body.amount_paid || null,
      denialCode: req.body.denial_code || null,
      queueId,
    });
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'payer_call', entityId: call.id, action: 'create', detail: { claim_id: claim.id, outcome, caller: req.body.caller || 'team', simulation: true } });
    res.status(201).json({
      ok: true,
      call: cleanRow(call),
      claim: cleanClaim(updatedClaim),
      simulation: true,
      simulationNote: 'Simulation mode — no live Twilio call was placed. Connect Twilio at deployment for live Sara calls.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
