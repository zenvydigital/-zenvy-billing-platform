'use strict';

/**
 * Demo data loader — one clearly-labelled sample clinic so a new clinic
 * owner can see the platform working before importing real data.
 *
 * Demo clinic: "Demo Clinic — SAMPLE DATA" (is_demo, BAA signed because
 * it is sample data, never real patient data). Contains:
 *   - 3 sample patients (initials only): L.M., T.K., A.B.
 *   - 2 authorizations (one expiring in 9 days), 3 verifications
 *   - 2 completed sessions, 4 claims (one clean, one the scrubber
 *     catches, one paid, one denied with an open appeal deadline)
 *   - 1 open denial (CO-97)
 * No ERA lines are created — ERA lines are financial records with no
 * delete path, so the demo never creates any.
 *
 * One-click remove deletes the demo clinic and every record under it,
 * in dependency order. Only a Zenvy platform owner can load/remove.
 */

const express = require('express');
const { query, getPool } = require('../db');
const { ApiError, isoDate } = require('../util');
const { requireAuth, requireOwner, requireClinicOwner, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { loadClinicSampleData } = require('../sample-data');

const router = express.Router();
router.use(requireAuth, requireOwner);

router.post('/load', async (req, res, next) => {
  try {
    if (req.user.clinic_id !== null) {
      throw new ApiError(403, 'Only the Zenvy platform owner can load demo data.');
    }
    const existing = await query("SELECT id FROM clinics WHERE is_demo = TRUE AND name = 'Demo Clinic — SAMPLE DATA' LIMIT 1");
    if (existing.rows.length > 0) {
      throw new ApiError(409, 'Demo data is already loaded. Remove it first if you want to reload it.');
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);

      const clinic = (await q(
        `INSERT INTO clinics (name, city, state, timezone, baa_signed, payer_calls_opt_in, alerts_enabled, is_demo)
         VALUES ('Demo Clinic — SAMPLE DATA', 'Sample City', 'OH', 'America/New_York', TRUE, FALSE, TRUE, TRUE) RETURNING *`
      )).rows[0];
      const cid = clinic.id;

      await loadClinicSampleData(q, cid);

      await client.query('COMMIT');
      await audit(query, { actor: req.user, clinicId: cid, entity: 'demo', entityId: cid, action: 'load', detail: { clinic: 'Demo Clinic — SAMPLE DATA' } });
      res.status(201).json({
        ok: true,
        demo: {
          clinicId: cid,
          name: 'Demo Clinic — SAMPLE DATA',
          note: 'Sample data only — no real patients. Remove it any time from Demo Data.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/** Remove all demo data, in dependency order (ERA lines and appeal drafts
 *  exist too once the demo clinic has been used in an e2e run). */
router.post('/remove', async (req, res, next) => {
  try {
    if (req.user.clinic_id !== null) {
      throw new ApiError(403, 'Only the Zenvy platform owner can remove demo data.');
    }
    const demos = await query('SELECT id, name FROM clinics WHERE is_demo = TRUE');
    if (demos.rows.length === 0) {
      return res.json({ ok: true, removed: 0, note: 'No demo data to remove.' });
    }
    const pool = getPool();
    const client = await pool.connect();
    let removedClinics = 0;
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);
      for (const demo of demos.rows) {
        const cid = demo.id;
        await q('DELETE FROM payer_calls WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM payer_call_queue WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM appeal_drafts WHERE claim_id IN (SELECT id FROM claims WHERE clinic_id = $1)', [cid]);
        await q('DELETE FROM era_lines WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM denials WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM claims WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM sessions WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM authorizations WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM verifications WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM referrals WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM patients WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM users WHERE clinic_id = $1', [cid]);
        await q('DELETE FROM clinics WHERE id = $1', [cid]);
        removedClinics += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(query, { actor: req.user, clinicId: null, entity: 'demo', entityId: null, action: 'remove', detail: { clinics_removed: removedClinics } });
    res.json({ ok: true, removed: removedClinics });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- clinic-scoped sample data
//
// Pass 5: a trial clinic owner loads sample data into THEIR OWN clinic
// (the platform demo loader above is Zenvy-owner-only and creates a
// separate demo clinic the trial user must never see). Same sample set —
// 3 patients (initials only), 2 authorizations, 3 verifications,
// 2 sessions, 4 claims, 1 open denial — all marked is_demo, so the
// clinic's real data is never mixed with it. The clinic's BAA flag is
// NOT touched: sample data is not real patient data, and the hard BAA
// gate still blocks real patient entry until the BAA is recorded.
// Remove deletes ONLY the sample rows inside this clinic.

const clinicDemo = express.Router({ mergeParams: true });
clinicDemo.use(requireAuth, loadClinic, requireClinicOwner);

clinicDemo.post('/load', async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const existing = await query(
      'SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE LIMIT 1',
      [cid]
    );
    if (existing.rows.length > 0) {
      throw new ApiError(409, 'Sample data is already loaded in this clinic. Remove it first if you want to reload it.');
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);

      await loadClinicSampleData(q, cid);

      await client.query('COMMIT');
      await audit(query, { actor: req.user, clinicId: cid, entity: 'demo', entityId: cid, action: 'load', detail: { clinic: req.clinic.name, scope: 'own-clinic' } });
      res.status(201).json({
        ok: true,
        demo: {
          clinicId: cid,
          name: req.clinic.name,
          note: 'Sample data only — no real patients. Remove it any time from the dashboard checklist.',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

clinicDemo.post('/remove', async (req, res, next) => {
  try {
    const cid = req.clinic.id;
    const pool = getPool();
    const client = await pool.connect();
    let removed = { patients: 0, claims: 0 };
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);
      // Demo rows are identified through the sample patients (verifications
      // and authorizations carry no is_demo flag) and the sample claims.
      const demoPatients = `(SELECT id FROM patients WHERE clinic_id = $1 AND is_demo = TRUE)`;
      const demoClaims = `(SELECT id FROM claims WHERE clinic_id = $1 AND is_demo = TRUE)`;
      await q(`DELETE FROM payer_calls WHERE clinic_id = $1 AND claim_id IN ${demoClaims}`, [cid]);
      await q(`DELETE FROM appeal_drafts WHERE claim_id IN ${demoClaims}`, [cid]);
      await q(`DELETE FROM denials WHERE clinic_id = $1 AND claim_id IN ${demoClaims}`, [cid]);
      await q(`DELETE FROM payer_call_queue WHERE clinic_id = $1 AND claim_id IN ${demoClaims}`, [cid]);
      const claimsDel = await q(
        `DELETE FROM claims WHERE clinic_id = $1 AND (is_demo = TRUE OR session_id IN (SELECT id FROM sessions WHERE clinic_id = $1 AND patient_id IN ${demoPatients}))`,
        [cid]
      );
      removed.claims = claimsDel.rowCount || 0;
      await q(`DELETE FROM sessions WHERE clinic_id = $1 AND patient_id IN ${demoPatients}`, [cid]);
      await q(`DELETE FROM verifications WHERE clinic_id = $1 AND patient_id IN ${demoPatients}`, [cid]);
      await q(`DELETE FROM authorizations WHERE clinic_id = $1 AND patient_id IN ${demoPatients}`, [cid]);
      await q(`DELETE FROM referrals WHERE clinic_id = $1 AND is_demo = TRUE`, [cid]);
      const patientsDel = await q(`DELETE FROM patients WHERE clinic_id = $1 AND is_demo = TRUE`, [cid]);
      removed.patients = patientsDel.rowCount || 0;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(query, { actor: req.user, clinicId: cid, entity: 'demo', entityId: cid, action: 'remove', detail: { scope: 'own-clinic', ...removed } });
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.router = router;
module.exports.clinicDemo = clinicDemo;
