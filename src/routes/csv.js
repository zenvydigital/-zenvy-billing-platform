'use strict';

/**
 * CSV import / export.
 *
 * Import flow (two steps, both JSON — the browser parses the file):
 *   POST /import/:type/preview  → per-row verdict: ready / needs-fixing /
 *                                  duplicate, with plain-language reasons
 *   POST /import/:type          → inserts the ready rows, reports
 *                                  inserted / skipped / failed
 * Export:
 *   GET /export/:type           → CSV download (claims, open AR, roster…)
 *   GET /templates/:type        → blank CSV template with the right headers
 *
 * Rules: initials only (full names rejected), date of birth is never stored
 * (a DOB column marks the row needs-fixing), and real-data imports need
 * the clinic's BAA signed (the same gate as manual entry).
 */

const express = require('express');
const { query } = require('../db');
const {
  ApiError, initialsError, isValidCpt, toMoney, toInt, isoDate, toCsv,
} = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

const TYPES = ['patients', 'referrals', 'authorizations', 'claims', 'sessions'];

const TEMPLATES = {
  patients: ['initials', 'payer', 'member_id'],
  referrals: ['referral_initials', 'source', 'notes'],
  authorizations: ['patient_initials', 'member_id', 'auth_number', 'payer', 'cpt_codes', 'total_units', 'units_used', 'start_date', 'end_date'],
  claims: ['patient_initials', 'member_id', 'auth_number', 'date_of_service', 'cpt_code', 'units', 'billed_amount', 'notes'],
  sessions: ['patient_initials', 'member_id', 'auth_number', 'session_date', 'cpt_code', 'units', 'duration_min', 'status', 'notes'],
};

function dobColumnPresent(row) {
  return Object.keys(row).some((k) => /dob|date.?of.?birth|birth.?date/i.test(k));
}

function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

async function findPatient(clinicId, initials, memberId) {
  if (!initials) return null;
  const { rows } = await query(
    'SELECT * FROM patients WHERE clinic_id = $1 AND initials = $2',
    [clinicId, String(initials).trim()]
  );
  if (rows.length === 0) return null;
  if (memberId) {
    const match = rows.find((p) => (p.member_id || '') === String(memberId).trim());
    return match || rows[0];
  }
  return rows[0];
}

async function findAuth(clinicId, authNumber) {
  if (!authNumber) return null;
  const { rows } = await query(
    'SELECT * FROM authorizations WHERE clinic_id = $1 AND auth_number = $2',
    [clinicId, String(authNumber).trim()]
  );
  return rows[0] || null;
}

/** Validate one row for a type. Returns { status, errors, resolved }. */
async function validateRow(clinicId, type, row, seen) {
  const errors = [];
  const resolved = {};
  if (dobColumnPresent(row)) {
    errors.push('A date-of-birth column is present — date of birth is never stored. Remove that column.');
  }
  const key = JSON.stringify(row);
  if (seen.has(key)) errors.push('This row appears twice in the file.');

  if (type === 'patients') {
    const e = initialsError(row.initials);
    if (e) errors.push(e);
    else resolved.initials = String(row.initials).trim();
    resolved.payer = row.payer || null;
    resolved.member_id = row.member_id || null;
    if (!errors.length) {
      const existing = await query(
        'SELECT member_id FROM patients WHERE clinic_id = $1 AND initials = $2',
        [clinicId, resolved.initials]
      );
      const dup = existing.rows.some((p) => (p.member_id || null) === (resolved.member_id || null));
      if (dup) return { status: 'duplicate', errors: ['This patient already exists in the clinic.'], resolved };
    }
  }

  if (type === 'referrals') {
    const e = initialsError(row.referral_initials, 'Referral initials');
    if (e) errors.push(e);
    else resolved.referral_initials = String(row.referral_initials).trim();
    resolved.source = row.source || null;
    resolved.notes = row.notes || null;
  }

  if (type === 'authorizations') {
    const e = initialsError(row.patient_initials, 'Patient initials');
    if (e) errors.push(e);
    const patient = await findPatient(clinicId, row.patient_initials, row.member_id);
    if (!patient) errors.push(`No patient with initials ${row.patient_initials || '(missing)'} exists in this clinic — import patients first.`);
    else resolved.patient_id = patient.id;
    if (!String(row.auth_number || '').trim()) errors.push('Authorization number is required.');
    else resolved.auth_number = String(row.auth_number).trim();
    const cpts = String(row.cpt_codes || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const c of cpts) if (!isValidCpt(c)) errors.push(`CPT ${c} is not a valid ABA code (97151–97158).`);
    resolved.cpt_codes = cpts.join(',') || null;
    resolved.payer = row.payer || null;
    resolved.total_units = toInt(row.total_units, 0);
    resolved.units_used = toInt(row.units_used, 0);
    if (row.start_date && !isDateStr(row.start_date)) errors.push('start_date must be YYYY-MM-DD.');
    if (row.end_date && !isDateStr(row.end_date)) errors.push('end_date must be YYYY-MM-DD.');
    resolved.start_date = row.start_date || null;
    resolved.end_date = row.end_date || null;
    if (!errors.length) {
      const dup = await query('SELECT id FROM authorizations WHERE clinic_id = $1 AND auth_number = $2', [clinicId, resolved.auth_number]);
      if (dup.rows.length > 0) return { status: 'duplicate', errors: [`Authorization ${resolved.auth_number} already exists.`], resolved };
    }
  }

  if (type === 'claims') {
    const e = initialsError(row.patient_initials, 'Patient initials');
    if (e) errors.push(e);
    const patient = await findPatient(clinicId, row.patient_initials, row.member_id);
    if (!patient) errors.push(`No patient with initials ${row.patient_initials || '(missing)'} exists in this clinic — import patients first.`);
    else resolved.patient_id = patient.id;
    if (row.auth_number) {
      const auth = await findAuth(clinicId, row.auth_number);
      if (!auth) errors.push(`Authorization ${row.auth_number} does not exist in this clinic.`);
      else resolved.authorization_id = auth.id;
    }
    if (!isDateStr(row.date_of_service)) errors.push('date_of_service must be YYYY-MM-DD.');
    else resolved.date_of_service = row.date_of_service;
    if (!isValidCpt(row.cpt_code)) errors.push(`CPT ${row.cpt_code || '(missing)'} is not a valid ABA code (97151–97158).`);
    else resolved.cpt_code = String(row.cpt_code).trim();
    resolved.units = toInt(row.units, 0);
    resolved.billed_amount = toMoney(row.billed_amount);
    resolved.notes = row.notes || null;
  }

  if (type === 'sessions') {
    const e = initialsError(row.patient_initials, 'Patient initials');
    if (e) errors.push(e);
    const patient = await findPatient(clinicId, row.patient_initials, row.member_id);
    if (!patient) errors.push(`No patient with initials ${row.patient_initials || '(missing)'} exists in this clinic — import patients first.`);
    else resolved.patient_id = patient.id;
    if (row.auth_number) {
      const auth = await findAuth(clinicId, row.auth_number);
      if (!auth) errors.push(`Authorization ${row.auth_number} does not exist in this clinic.`);
      else resolved.authorization_id = auth.id;
    }
    if (!isDateStr(row.session_date)) errors.push('session_date must be YYYY-MM-DD.');
    else resolved.session_date = row.session_date;
    if (!isValidCpt(row.cpt_code)) errors.push(`CPT ${row.cpt_code || '(missing)'} is not a valid ABA code (97151–97158).`);
    else resolved.cpt_code = String(row.cpt_code).trim();
    resolved.units = toInt(row.units, 0);
    resolved.duration_min = row.duration_min ? toInt(row.duration_min) : null;
    if (row.status && !['scheduled', 'completed', 'cancelled', 'billed'].includes(row.status)) errors.push('status must be scheduled, completed, cancelled or billed.');
    else resolved.status = row.status || 'scheduled';
    resolved.notes = row.notes || null;
  }

  if (errors.length > 0) return { status: 'needs-fixing', errors, resolved };
  return { status: 'ready', errors: [], resolved };
}

async function previewRows(clinicId, type, rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const verdict = await validateRow(clinicId, type, row, seen);
    seen.add(JSON.stringify(row));
    out.push({ row, status: verdict.status, errors: verdict.errors, resolved: verdict.resolved });
  }
  return out;
}

async function insertRow(clinicId, type, r) {
  switch (type) {
    case 'patients':
      return query(
        `INSERT INTO patients (clinic_id, initials, payer, member_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [clinicId, r.initials, r.payer, r.member_id]
      );
    case 'referrals':
      return query(
        `INSERT INTO referrals (clinic_id, referral_initials, source, notes) VALUES ($1, $2, $3, $4) RETURNING id`,
        [clinicId, r.referral_initials, r.source, r.notes]
      );
    case 'authorizations':
      return query(
        `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [clinicId, r.patient_id, r.auth_number, r.payer, r.cpt_codes, r.total_units, r.units_used, r.start_date, r.end_date]
      );
    case 'claims':
      return query(
        `INSERT INTO claims (clinic_id, patient_id, authorization_id, date_of_service, cpt_code, units, billed_amount, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [clinicId, r.patient_id, r.authorization_id || null, r.date_of_service, r.cpt_code, r.units, r.billed_amount, r.notes]
      );
    case 'sessions':
      return query(
        `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [clinicId, r.patient_id, r.authorization_id || null, r.session_date, r.cpt_code, r.units, r.duration_min, r.status, r.notes]
      );
    default:
      throw new ApiError(400, `Unknown import type: ${type}`);
  }
}

router.get('/templates/:type', requireAuth, (req, res, next) => {
  try {
    const type = req.params.type;
    if (!TYPES.includes(type)) throw new ApiError(400, `Unknown template type: ${type}`);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="zenvy-${type}-template.csv"`);
    res.send(`${TEMPLATES[type].join(',')}\n`);
  } catch (err) {
    next(err);
  }
});

router.post('/import/:type/preview', requireWrite, async (req, res, next) => {
  try {
    const type = req.params.type;
    if (!TYPES.includes(type)) throw new ApiError(400, `Unknown import type: ${type}`);
    const rows = req.body.rows;
    if (!Array.isArray(rows)) throw new ApiError(400, 'Send rows as a JSON array.');
    const verdicts = await previewRows(req.clinic.id, type, rows);
    res.json({
      ok: true,
      preview: verdicts,
      summary: {
        total: verdicts.length,
        ready: verdicts.filter((v) => v.status === 'ready').length,
        needsFixing: verdicts.filter((v) => v.status === 'needs-fixing').length,
        duplicates: verdicts.filter((v) => v.status === 'duplicate').length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/import/:type', requireWrite, async (req, res, next) => {
  try {
    const type = req.params.type;
    if (!TYPES.includes(type)) throw new ApiError(400, `Unknown import type: ${type}`);
    if (!req.clinic.baa_signed) {
      throw new ApiError(403, 'This clinic has not signed the BAA yet — real data cannot be imported until the BAA is recorded.');
    }
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'Send rows as a JSON array.');
    const verdicts = await previewRows(req.clinic.id, type, rows);
    let inserted = 0;
    let skipped = 0;
    const failed = [];
    for (const v of verdicts) {
      if (v.status === 'duplicate') { skipped += 1; continue; }
      if (v.status !== 'ready') { failed.push({ row: v.row, errors: v.errors }); continue; }
      try {
        await insertRow(req.clinic.id, type, v.resolved);
        inserted += 1;
      } catch (err) {
        if (err.code === '23505') skipped += 1;
        else failed.push({ row: v.row, errors: [err.message] });
      }
    }
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'import', entityId: null, action: 'import',
      detail: { type, inserted, skipped, failed: failed.length },
    });
    res.json({ ok: true, type, inserted, skipped, failed });
  } catch (err) {
    next(err);
  }
});

router.get('/export/:type', async (req, res, next) => {
  try {
    const type = req.params.type;
    const cid = req.clinic.id;
    let headers;
    let rows;
    if (type === 'patients' || type === 'roster') {
      headers = ['initials', 'payer', 'member_id', 'status'];
      rows = (await query('SELECT initials, payer, member_id, status FROM patients WHERE clinic_id = $1 ORDER BY initials', [cid])).rows;
    } else if (type === 'referrals') {
      headers = ['referral_initials', 'source', 'status', 'notes'];
      rows = (await query('SELECT referral_initials, source, status, notes FROM referrals WHERE clinic_id = $1 ORDER BY created_at DESC', [cid])).rows;
    } else if (type === 'authorizations') {
      headers = ['patient_initials', 'auth_number', 'payer', 'cpt_codes', 'total_units', 'units_used', 'start_date', 'end_date', 'status'];
      rows = (await query(
        `SELECT p.initials AS patient_initials, a.auth_number, a.payer, a.cpt_codes, a.total_units, a.units_used, a.start_date, a.end_date, a.status
           FROM authorizations a JOIN patients p ON p.id = a.patient_id WHERE a.clinic_id = $1 ORDER BY a.end_date`,
        [cid]
      )).rows.map((r) => ({ ...r, start_date: isoDate(r.start_date), end_date: isoDate(r.end_date) }));
    } else if (type === 'claims') {
      headers = ['patient_initials', 'date_of_service', 'cpt_code', 'units', 'billed_amount', 'paid_amount', 'status', 'payer_claim_number'];
      rows = (await query(
        `SELECT p.initials AS patient_initials, c.date_of_service, c.cpt_code, c.units, c.billed_amount, c.paid_amount, c.status, c.payer_claim_number
           FROM claims c JOIN patients p ON p.id = c.patient_id WHERE c.clinic_id = $1 ORDER BY c.date_of_service DESC`,
        [cid]
      )).rows.map((r) => ({ ...r, date_of_service: isoDate(r.date_of_service) }));
    } else if (type === 'sessions') {
      headers = ['patient_initials', 'session_date', 'cpt_code', 'units', 'duration_min', 'status'];
      rows = (await query(
        `SELECT p.initials AS patient_initials, s.session_date, s.cpt_code, s.units, s.duration_min, s.status
           FROM sessions s JOIN patients p ON p.id = s.patient_id WHERE s.clinic_id = $1 ORDER BY s.session_date DESC`,
        [cid]
      )).rows.map((r) => ({ ...r, session_date: isoDate(r.session_date) }));
    } else if (type === 'ar') {
      headers = ['patient_initials', 'date_of_service', 'cpt_code', 'billed_amount', 'paid_amount', 'balance', 'status'];
      rows = (await query(
        `SELECT p.initials AS patient_initials, c.date_of_service, c.cpt_code, c.billed_amount, c.paid_amount,
                (c.billed_amount - c.paid_amount) AS balance, c.status
           FROM claims c JOIN patients p ON p.id = c.patient_id
          WHERE c.clinic_id = $1 AND c.status IN ('submitted', 'partial', 'denied') ORDER BY c.date_of_service ASC`,
        [cid]
      )).rows.map((r) => ({ ...r, date_of_service: isoDate(r.date_of_service) }));
    } else {
      throw new ApiError(400, `Unknown export type: ${type}`);
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="zenvy-${type}-clinic-${cid}.csv"`);
    res.send(toCsv(headers, rows));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
