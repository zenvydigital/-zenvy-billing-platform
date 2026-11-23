'use strict';

/**
 * Automatic claim scrubber (scrubclaim).
 *
 * Checks, in order:
 *   1. CPT validity — must be an ABA code 97151–97158.
 *   2. Billed amount — must be greater than $0.
 *   3. Eligibility — latest verification must be 'eligible'. Missing or
 *      'ineligible' is an ERROR; 'pending' is a WARNING (does not fail
 *      the scrub on its own).
 *   4. Authorization — must be linked, active, cover the CPT and the
 *      date of service, and have enough units remaining.
 *   5. Duplicates — same clinic + patient + date of service + CPT + units.
 *
 * A claim CANNOT be marked submitted until scrub passes (enforced in the
 * submit route, not just the UI). Scrub results are stored on the claim
 * (scrub_status + scrub_errors JSONB) so the biller can see exactly why.
 */

const { isValidCpt, isoDate, daysUntil } = require('./util');

async function runScrub(q, clinicId, claim) {
  const errors = [];
  const warnings = [];

  // 1. CPT validity
  if (!isValidCpt(claim.cpt_code)) {
    errors.push({
      code: 'cpt-invalid',
      severity: 'error',
      message: `CPT ${claim.cpt_code || '(missing)'} is not a valid ABA code (97151–97158).`,
    });
  }

  // 2. Billed amount
  if (!(Number(claim.billed_amount) > 0)) {
    errors.push({
      code: 'amount',
      severity: 'error',
      message: 'Billed amount must be greater than $0.',
    });
  }

  // 3. Eligibility (latest verification for the patient)
  const ver = await q(
    `SELECT * FROM verifications WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [claim.patient_id]
  );
  if (ver.rows.length === 0) {
    errors.push({
      code: 'eligibility-missing',
      severity: 'error',
      message: 'No eligibility verification is on file for this patient.',
    });
  } else if (ver.rows[0].status === 'ineligible') {
    errors.push({
      code: 'eligibility-ineligible',
      severity: 'error',
      message: `Eligibility check says this patient is ineligible with ${ver.rows[0].payer || 'the payer'}.`,
    });
  } else if (ver.rows[0].status === 'pending') {
    warnings.push({
      code: 'eligibility-pending',
      severity: 'warning',
      message: 'Eligibility is still pending — confirm coverage before submitting.',
    });
  }

  // 4. Authorization coverage + remaining units + dates
  if (!claim.authorization_id) {
    errors.push({
      code: 'auth-missing',
      severity: 'error',
      message: 'No authorization is linked to this claim.',
    });
  } else {
    const authRes = await q('SELECT * FROM authorizations WHERE id = $1', [claim.authorization_id]);
    if (authRes.rows.length === 0) {
      errors.push({
        code: 'auth-missing',
        severity: 'error',
        message: 'The linked authorization no longer exists.',
      });
    } else {
      const auth = authRes.rows[0];
      // 'active' and 'expiring' both cover a claim — an expiring auth has
      // not ended yet. 'expired' / 'exhausted' cannot cover anything.
      if (!['active', 'expiring'].includes(auth.status)) {
        errors.push({
          code: 'auth-status',
          severity: 'error',
          message: `Authorization ${auth.auth_number} is ${auth.status} — it cannot cover this claim.`,
        });
      }
      // Warning (never a fail): the auth ends soon — renew it.
      if (auth.end_date) {
        const daysLeft = daysUntil(auth.end_date);
        if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 30) {
          warnings.push({
            code: 'auth-expiring',
            severity: 'warning',
            message: `Authorization ${auth.auth_number} ends in ${daysLeft} day(s) — renew it soon.`,
          });
        }
      }
      if (auth.cpt_codes) {
        const covered = auth.cpt_codes.split(',').map((s) => s.trim());
        if (isValidCpt(claim.cpt_code) && !covered.includes(claim.cpt_code)) {
          errors.push({
            code: 'auth-cpt',
            severity: 'error',
            message: `Authorization ${auth.auth_number} does not cover CPT ${claim.cpt_code}.`,
          });
        }
      }
      const remaining = (auth.total_units || 0) - (auth.units_used || 0);
      if ((claim.units || 0) > remaining) {
        errors.push({
          code: 'auth-units',
          severity: 'error',
          message: `Authorization ${auth.auth_number} has ${remaining} unit(s) left, but this claim needs ${claim.units}.`,
        });
      }
      const dos = isoDate(claim.date_of_service);
      if (auth.start_date && dos && dos < isoDate(auth.start_date)) {
        errors.push({
          code: 'auth-dates',
          severity: 'error',
          message: `Date of service ${dos} is before authorization ${auth.auth_number} starts (${isoDate(auth.start_date)}).`,
        });
      }
      if (auth.end_date && dos && dos > isoDate(auth.end_date)) {
        errors.push({
          code: 'auth-dates',
          severity: 'error',
          message: `Date of service ${dos} is after authorization ${auth.auth_number} ends (${isoDate(auth.end_date)}).`,
        });
      }
    }
  }

  // 5. Duplicates (same clinic + patient + DOS + CPT + units, another claim)
  const dup = await q(
    `SELECT id FROM claims
      WHERE clinic_id = $1 AND patient_id = $2 AND date_of_service = $3
        AND cpt_code = $4 AND units = $5 AND id <> $6
        AND status NOT IN ('denied')
      LIMIT 1`,
    [clinicId, claim.patient_id, claim.date_of_service, claim.cpt_code, claim.units, claim.id]
  );
  if (dup.rows.length > 0) {
    errors.push({
      code: 'duplicate',
      severity: 'error',
      message: `A claim already exists for this patient, date and CPT (claim #${dup.rows[0].id}).`,
    });
  }

  return { passed: errors.length === 0, errors: [...errors, ...warnings] };
}

module.exports = { runScrub };
