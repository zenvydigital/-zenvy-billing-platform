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
const { requireAuth, requireOwner } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireAuth, requireOwner);

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

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

      const mkPatient = async (initials, payer, memberId) => (await q(
        `INSERT INTO patients (clinic_id, initials, payer, member_id, is_demo) VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
        [cid, initials, payer, memberId]
      )).rows[0];
      const lm = await mkPatient('L.M.', 'BCBS', 'M-1001');
      const tk = await mkPatient('T.K.', 'Aetna', 'M-1002');
      const ab = await mkPatient('A.B.', 'UHC', 'M-1003');

      await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'BCBS', 'eligible')`, [cid, lm.id]);
      await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'Aetna', 'pending')`, [cid, tk.id]);
      await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'UHC', 'eligible')`, [cid, ab.id]);

      const auth1 = (await q(
        `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
         VALUES ($1, $2, 'AUTH-DEMO-1', 'BCBS', '97153', 40, 8, $3, $4) RETURNING *`,
        [cid, lm.id, daysFromNow(-60), daysFromNow(9)]
      )).rows[0];
      const auth2 = (await q(
        `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
         VALUES ($1, $2, 'AUTH-DEMO-2', 'Aetna', '97153,97155', 20, 18, $3, $4) RETURNING *`,
        [cid, tk.id, daysFromNow(-30), daysFromNow(60)]
      )).rows[0];

      const s1 = (await q(
        `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status)
         VALUES ($1, $2, $3, $4, '97153', 4, 60, 'completed') RETURNING *`,
        [cid, lm.id, auth1.id, daysFromNow(-3)]
      )).rows[0];
      const s2 = (await q(
        `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status)
         VALUES ($1, $2, $3, $4, '97153', 4, 60, 'completed') RETURNING *`,
        [cid, tk.id, auth2.id, daysFromNow(-4)]
      )).rows[0];

      // C1: clean claim — scrub passes.
      const c1 = (await q(
        `INSERT INTO claims (clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed_amount, is_demo)
         VALUES ($1, $2, $3, $4, $5, '97153', 4, 240, TRUE) RETURNING *`,
        [cid, lm.id, auth1.id, s1.id, daysFromNow(-3)]
      )).rows[0];
      // C2: problem claim — needs 8 units, only 2 left on AUTH-DEMO-2.
      const c2 = (await q(
        `INSERT INTO claims (clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed_amount, is_demo)
         VALUES ($1, $2, $3, $4, $5, '97153', 8, 480, TRUE) RETURNING *`,
        [cid, tk.id, auth2.id, s2.id, daysFromNow(-4)]
      )).rows[0];
      // C3: paid claim (recovered money on the dashboard).
      await q(
        `INSERT INTO claims (clinic_id, patient_id, authorization_id, date_of_service, cpt_code, units, billed_amount, paid_amount, status, scrub_status, is_demo)
         VALUES ($1, $2, $3, $4, '97153', 4, 240, 240, 'paid', 'passed', TRUE)`,
        [cid, lm.id, auth1.id, daysFromNow(-10)]
      );
      // C4: denied claim with an open denial + appeal deadline in 10 days.
      const c4 = (await q(
        `INSERT INTO claims (clinic_id, patient_id, date_of_service, cpt_code, units, billed_amount, status, scrub_status, is_demo)
         VALUES ($1, $2, $3, '97155', 2, 160, 'denied', 'passed', TRUE) RETURNING *`,
        [cid, ab.id, daysFromNow(-13)]
      )).rows[0];
      await q(
        `INSERT INTO denials (clinic_id, claim_id, patient_id, denial_code, reason, status, appeal_deadline)
         VALUES ($1, $2, $3, 'CO-97', 'The benefit for this service is included in the payment for another service already adjudicated.', 'open', $4)`,
        [cid, c4.id, ab.id, daysFromNow(10)]
      );
      await q("UPDATE sessions SET claim_id = $1, status = 'billed' WHERE id = $2", [c1.id, s1.id]);
      await q("UPDATE sessions SET claim_id = $1, status = 'billed' WHERE id = $2", [c2.id, s2.id]);

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

module.exports = router;
