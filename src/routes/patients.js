'use strict';

/**
 * Patients + referrals.
 *
 * Hard rules:
 *   - Patients are stored by INITIALS ONLY (never full names, never DOB).
 *   - BAA GATE: a clinic without a signed BAA cannot hold real patient or
 *     referral data — the server rejects the entry with a plain message.
 *     Demo data (is_demo) is the only exception.
 *   - Patient delete unlinks/closes its referrals; a patient with billing
 *     records cannot be deleted (plain message, never raw SQL).
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, applyMerge, initialsError } = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

function cleanPatient(p) {
  return cleanRow(p);
}

/** The BAA gate — real data needs a signed BAA. */
function requireBaa(clinic) {
  if (!clinic.baa_signed) {
    throw new ApiError(
      403,
      'This clinic has not signed the BAA (Business Associate Agreement) yet. Real patient data cannot be entered until the BAA is recorded — ask the clinic owner to sign it first.'
    );
  }
}

// ---------------------------------------------------------------- patients

router.get('/patients', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM patients WHERE clinic_id = $1 ORDER BY initials',
      [req.clinic.id]
    );
    res.json({ ok: true, patients: rows.map(cleanPatient) });
  } catch (err) {
    next(err);
  }
});

router.post('/patients', requireWrite, async (req, res, next) => {
  try {
    requireBaa(req.clinic);
    const errMsg = initialsError(req.body.initials);
    if (errMsg) throw new ApiError(400, errMsg);
    const initials = String(req.body.initials).trim();
    let patient;
    try {
      const ins = await query(
        `INSERT INTO patients (clinic_id, initials, payer, member_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.clinic.id, initials, req.body.payer || null, req.body.member_id || null]
      );
      patient = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new ApiError(400, `A patient with initials ${initials} and that member ID already exists in this clinic.`);
      }
      throw err;
    }
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'patient', entityId: patient.id, action: 'create', detail: { initials } });
    res.status(201).json({ ok: true, patient: cleanPatient(patient) });
  } catch (err) {
    next(err);
  }
});

router.get('/patients/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM patients WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Patient not found.');
    res.json({ ok: true, patient: cleanPatient(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.patch('/patients/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM patients WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Patient not found.');
    if (req.body.initials !== undefined) {
      const errMsg = initialsError(req.body.initials);
      if (errMsg) throw new ApiError(400, errMsg);
    }
    if (req.body.status !== undefined && !['active', 'discharged'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be active or discharged.');
    }
    const updated = await applyMerge(query, 'patients', rows[0], ['initials', 'payer', 'member_id', 'status'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'patient', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, patient: cleanPatient(updated) });
  } catch (err) {
    next(err);
  }
});

router.delete('/patients/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM patients WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Patient not found.');
    const patient = rows[0];
    // Billing records block the delete (FK RESTRICT) — check first, plain message.
    const blocking = [];
    for (const [label, table] of [
      ['eligibility verifications', 'verifications'],
      ['authorizations', 'authorizations'],
      ['sessions', 'sessions'],
      ['claims', 'claims'],
      ['denials', 'denials'],
    ]) {
      const r = await query(`SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1`, [patient.id]);
      if (r.rows[0].n > 0) blocking.push(`${r.rows[0].n} ${label}`);
    }
    if (blocking.length > 0) {
      throw new ApiError(
        409,
        `This patient cannot be deleted — they still have ${blocking.join(', ')}. Discharge the patient instead; billing records are kept for the clinic's history.`
      );
    }
    // Converted referrals are unlinked and closed (the patient record goes, the referral stays).
    await query(
      `UPDATE referrals SET patient_id = NULL, status = 'closed'
        WHERE patient_id = $1 AND status = 'converted'`,
      [patient.id]
    );
    await query('DELETE FROM patients WHERE id = $1', [patient.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'patient', entityId: patient.id, action: 'delete', detail: { initials: patient.initials } });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- referrals

router.get('/referrals', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM referrals WHERE clinic_id = $1 ORDER BY created_at DESC',
      [req.clinic.id]
    );
    res.json({ ok: true, referrals: rows.map((r) => cleanRow(r)) });
  } catch (err) {
    next(err);
  }
});

router.post('/referrals', requireWrite, async (req, res, next) => {
  try {
    requireBaa(req.clinic);
    const errMsg = initialsError(req.body.referral_initials, 'Referral initials');
    if (errMsg) throw new ApiError(400, errMsg);
    const ins = await query(
      `INSERT INTO referrals (clinic_id, referral_initials, source, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.clinic.id, String(req.body.referral_initials).trim(), req.body.source || null, req.body.notes || null]
    );
    const referral = ins.rows[0];
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'referral', entityId: referral.id, action: 'create', detail: { initials: referral.referral_initials } });
    res.status(201).json({ ok: true, referral: cleanRow(referral) });
  } catch (err) {
    next(err);
  }
});

router.patch('/referrals/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM referrals WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Referral not found.');
    if (req.body.referral_initials !== undefined) {
      const errMsg = initialsError(req.body.referral_initials, 'Referral initials');
      if (errMsg) throw new ApiError(400, errMsg);
    }
    if (req.body.status !== undefined && !['new', 'contacted', 'converted', 'closed'].includes(req.body.status)) {
      throw new ApiError(400, 'Status must be new, contacted, converted or closed.');
    }
    const updated = await applyMerge(query, 'referrals', rows[0], ['referral_initials', 'source', 'notes', 'status'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'referral', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, referral: cleanRow(updated) });
  } catch (err) {
    next(err);
  }
});

/** Convert a referral into a patient, in one tap. */
router.post('/referrals/:id/convert', requireWrite, async (req, res, next) => {
  try {
    requireBaa(req.clinic);
    const { rows } = await query('SELECT * FROM referrals WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Referral not found.');
    const referral = rows[0];
    if (referral.status === 'converted' && referral.patient_id) {
      throw new ApiError(409, 'This referral has already been converted into a patient.');
    }
    let patient;
    try {
      const ins = await query(
        `INSERT INTO patients (clinic_id, initials, payer, member_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.clinic.id, referral.referral_initials, req.body.payer || null, req.body.member_id || null]
      );
      patient = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // Same initials + member ID already a patient: link to the existing one.
        const existing = await query(
          'SELECT * FROM patients WHERE clinic_id = $1 AND initials = $2',
          [req.clinic.id, referral.referral_initials]
        );
        const match = existing.rows.find(
          (p) => (p.member_id || null) === (req.body.member_id || null)
        );
        if (match) patient = match;
        else throw err;
      } else throw err;
    }
    const updated = await query(
      `UPDATE referrals SET patient_id = $1, status = 'converted', updated_at = now()
        WHERE id = $2 RETURNING *`,
      [patient.id, referral.id]
    );
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'referral', entityId: referral.id, action: 'convert', detail: { patient_id: patient.id, initials: patient.initials } });
    res.json({ ok: true, referral: cleanRow(updated.rows[0]), patient: cleanPatient(patient) });
  } catch (err) {
    next(err);
  }
});

router.delete('/referrals/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM referrals WHERE id = $1 AND clinic_id = $2', [req.params.id, req.clinic.id]);
    if (rows.length === 0) throw new ApiError(404, 'Referral not found.');
    await query('DELETE FROM referrals WHERE id = $1', [req.params.id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'referral', entityId: Number(req.params.id), action: 'delete', detail: { initials: rows[0].referral_initials } });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
