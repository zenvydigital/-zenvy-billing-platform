'use strict';

/**
 * Clinic sample data — the same clearly-labelled set everywhere it is
 * loaded (Pass 2 platform demo loader, Pass 5 clinic-scoped loader,
 * Pass 5 follow-up #2 auto-load on trial signup):
 *   - 3 sample patients (initials only): L.M., T.K., A.B.
 *   - 2 authorizations (one expiring in 9 days), 3 verifications
 *   - 2 completed sessions, 4 claims (one clean, one the scrubber
 *     catches, one paid, one denied with an open appeal deadline)
 *   - 1 open denial (CO-97)
 * No ERA lines are created — ERA lines are financial records with no
 * delete path, so sample data never creates any.
 *
 * Every patient and claim is marked is_demo; verifications,
 * authorizations, sessions and denials are tied to the sample
 * patients/claims, so the remove path finds them through those.
 * The clinic's BAA flag is NOT touched: sample data is not real
 * patient data, and the hard BAA gate still blocks real patient entry
 * until the BAA is recorded.
 *
 * q is a query function bound to a transaction client:
 *   (text, params) => client.query(text, params)
 * The caller owns the transaction (BEGIN/COMMIT/ROLLBACK) and the
 * 409 "already loaded" guard — this function only inserts.
 */

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

async function loadClinicSampleData(q, clinicId) {
  const mkPatient = async (initials, payer, memberId) => (await q(
    `INSERT INTO patients (clinic_id, initials, payer, member_id, is_demo) VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
    [clinicId, initials, payer, memberId]
  )).rows[0];
  const lm = await mkPatient('L.M.', 'BCBS', 'M-1001');
  const tk = await mkPatient('T.K.', 'Aetna', 'M-1002');
  const ab = await mkPatient('A.B.', 'UHC', 'M-1003');

  await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'BCBS', 'eligible')`, [clinicId, lm.id]);
  await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'Aetna', 'pending')`, [clinicId, tk.id]);
  await q(`INSERT INTO verifications (clinic_id, patient_id, payer, status) VALUES ($1, $2, 'UHC', 'eligible')`, [clinicId, ab.id]);

  const auth1 = (await q(
    `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
     VALUES ($1, $2, 'AUTH-DEMO-1', 'BCBS', '97153', 40, 8, $3, $4) RETURNING *`,
    [clinicId, lm.id, daysFromNow(-60), daysFromNow(9)]
  )).rows[0];
  const auth2 = (await q(
    `INSERT INTO authorizations (clinic_id, patient_id, auth_number, payer, cpt_codes, total_units, units_used, start_date, end_date)
     VALUES ($1, $2, 'AUTH-DEMO-2', 'Aetna', '97153,97155', 20, 18, $3, $4) RETURNING *`,
    [clinicId, tk.id, daysFromNow(-30), daysFromNow(60)]
  )).rows[0];

  const s1 = (await q(
    `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status)
     VALUES ($1, $2, $3, $4, '97153', 4, 60, 'completed') RETURNING *`,
    [clinicId, lm.id, auth1.id, daysFromNow(-3)]
  )).rows[0];
  const s2 = (await q(
    `INSERT INTO sessions (clinic_id, patient_id, authorization_id, session_date, cpt_code, units, duration_min, status)
     VALUES ($1, $2, $3, $4, '97153', 4, 60, 'completed') RETURNING *`,
    [clinicId, tk.id, auth2.id, daysFromNow(-4)]
  )).rows[0];

  // C1: clean claim — scrub passes.
  const c1 = (await q(
    `INSERT INTO claims (clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed_amount, is_demo)
     VALUES ($1, $2, $3, $4, $5, '97153', 4, 240, TRUE) RETURNING *`,
    [clinicId, lm.id, auth1.id, s1.id, daysFromNow(-3)]
  )).rows[0];
  // C2: problem claim — needs 8 units, only 2 left on AUTH-DEMO-2.
  const c2 = (await q(
    `INSERT INTO claims (clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed_amount, is_demo)
     VALUES ($1, $2, $3, $4, $5, '97153', 8, 480, TRUE) RETURNING *`,
    [clinicId, tk.id, auth2.id, s2.id, daysFromNow(-4)]
  )).rows[0];
  // C3: paid claim (recovered money on the dashboard).
  await q(
    `INSERT INTO claims (clinic_id, patient_id, authorization_id, date_of_service, cpt_code, units, billed_amount, paid_amount, status, scrub_status, is_demo)
     VALUES ($1, $2, $3, $4, '97153', 4, 240, 240, 'paid', 'passed', TRUE)`,
    [clinicId, lm.id, auth1.id, daysFromNow(-10)]
  );
  // C4: denied claim with an open denial + appeal deadline in 10 days.
  const c4 = (await q(
    `INSERT INTO claims (clinic_id, patient_id, date_of_service, cpt_code, units, billed_amount, status, scrub_status, is_demo)
     VALUES ($1, $2, $3, '97155', 2, 160, 'denied', 'passed', TRUE) RETURNING *`,
    [clinicId, ab.id, daysFromNow(-13)]
  )).rows[0];
  await q(
    `INSERT INTO denials (clinic_id, claim_id, patient_id, denial_code, reason, status, appeal_deadline)
     VALUES ($1, $2, $3, 'CO-97', 'The benefit for this service is included in the payment for another service already adjudicated.', 'open', $4)`,
    [clinicId, c4.id, ab.id, daysFromNow(10)]
  );
  await q("UPDATE sessions SET claim_id = $1, status = 'billed' WHERE id = $2", [c1.id, s1.id]);
  await q("UPDATE sessions SET claim_id = $1, status = 'billed' WHERE id = $2", [c2.id, s2.id]);

  return { patients: 3, verifications: 3, authorizations: 2, sessions: 2, claims: 4, denials: 1 };
}

module.exports = { loadClinicSampleData, daysFromNow };
