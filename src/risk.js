'use strict';

/**
 * Denial-risk score (Pass 4) — rule-based 0–100 with NAMED factors.
 *
 * The score reuses the scrubber as its single source of truth: every
 * scrub error/warning maps to points, so the risk score can never
 * contradict the scrub verdict. Two factors the scrubber does not
 * cover are added: a prior denial on the same patient, and a claim
 * that has sat submitted for over 30 days with no payment.
 *
 * Bands:  0–24 low · 25–49 medium · 50–100 high.
 * (A claim with pending eligibility AND short auth units scores 50 —
 * that is genuinely high risk: it will almost certainly deny.)
 *
 * Stored on the claim (risk_score + risk_factors JSONB) by the
 * POST /claims/:id/risk endpoint, and shown in the Claims tab.
 */

const { runScrub } = require('./scrub');
const { daysUntil, isoDate } = require('./util');

// Points per scrub error code (scrub.js codes are the source of truth).
const SCRUB_POINTS = {
  'cpt-invalid': 20,
  amount: 10,
  'eligibility-missing': 25,
  'eligibility-ineligible': 40,
  'eligibility-pending': 15,
  'auth-missing': 20,
  'auth-status': 25,
  'auth-cpt': 15,
  'auth-units': 35,
  'auth-dates': 15,
  duplicate: 20,
  // 'auth-expiring' is a warning handled separately below (points depend
  // on how soon the auth ends) — it is not mapped here on purpose.
};

function bandFor(score) {
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/**
 * Score a claim. Returns { score, band, factors } where each factor is
 * { code, points, message }. Never throws for missing data — a missing
 * verification or authorization is itself a risk factor.
 */
async function scoreClaim(q, clinicId, claim) {
  const factors = [];
  const add = (code, points, message) => {
    factors.push({ code, points, message });
  };

  // 1. Scrub verdict, mapped to points.
  const scrub = await runScrub(q, clinicId, claim);
  for (const e of scrub.errors) {
    if (e.code === 'auth-expiring') continue; // handled in step 2
    const points = SCRUB_POINTS[e.code];
    if (points) add(e.code, points, e.message);
  }

  // 2. Authorization expiring soon (warning only in the scrubber).
  if (claim.authorization_id) {
    const authRes = await q('SELECT * FROM authorizations WHERE id = $1', [claim.authorization_id]);
    if (authRes.rows.length > 0) {
      const auth = authRes.rows[0];
      const daysLeft = daysUntil(auth.end_date);
      if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 7) {
        add('auth-expiring-soon', 10, `Authorization ${auth.auth_number} ends in ${daysLeft} day(s) — renew it now or the next claim will deny.`);
      } else if (daysLeft !== null && daysLeft > 7 && daysLeft <= 30) {
        add('auth-expiring', 5, `Authorization ${auth.auth_number} ends in ${daysLeft} day(s) — renew it soon.`);
      }
    }
  }

  // 3. Prior denial on the same patient (any claim).
  const prior = await q(
    `SELECT count(*)::int AS n FROM denials WHERE clinic_id = $1 AND patient_id = $2`,
    [clinicId, claim.patient_id]
  );
  if (prior.rows[0].n > 0) {
    add('prior-denial', 10, `This patient already has ${prior.rows[0].n} denial(s) on record — payers scrutinise repeat claims.`);
  }

  // 4. Stale submitted claim — over 30 days with no payment.
  if (claim.status === 'submitted' && claim.date_of_service) {
    const ageDays = Math.floor((Date.now() - new Date(`${isoDate(claim.date_of_service)}T00:00:00Z`).getTime()) / 86400000);
    if (ageDays > 30) {
      add('stale-submitted', 10, `Submitted ${ageDays} days ago with no payment posted — follow up with the payer.`);
    }
  }

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  return { score, band: bandFor(score), factors };
}

module.exports = { scoreClaim, bandFor };
