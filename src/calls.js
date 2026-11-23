'use strict';

/**
 * Shared payer-call outcome logic (Pass 4).
 *
 * Extracted unchanged from the POST /payer-calls route (Pass 2) so the
 * Sara dialer bridge (importCallResults) applies exactly the same rules
 * as a call logged by hand:
 *   paid   → claim paid (+ open denials resolved)
 *   denied → claim denied + denial recorded (if none open)
 *   partial / pending / info-received → logged only, claim keeps its status
 *
 * The caller (route) owns validation, the opt-in check and the audit
 * entry; this helper only writes the call row and applies the outcome.
 * Every call written here is labelled simulated until Twilio live
 * calling is connected at deployment.
 */

const { toMoney } = require('./util');

const OUTCOMES = ['paid', 'denied', 'partial', 'pending', 'info-received'];

/**
 * Write a payer call and apply its outcome to the claim.
 * Returns { call, claim } — the call row and the claim row after the outcome.
 */
async function applyCallOutcome(q, clinicId, claim, opts) {
  const {
    caller = 'team',
    outcome,
    statusAnswer = null,
    referenceNumber = null,
    nextAction = null,
    amountPaid = null,
    denialCode = null,
    queueId = null,
  } = opts;

  const ins = await q(
    `INSERT INTO payer_calls (clinic_id, claim_id, queue_id, caller, outcome, status_answer, reference_number, next_action, is_simulated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
    [clinicId, claim.id, queueId, caller, outcome, statusAnswer, referenceNumber, nextAction]
  );
  const call = ins.rows[0];

  if (queueId) {
    await q("UPDATE payer_call_queue SET status = 'done', updated_at = now() WHERE id = $1", [queueId]);
  }

  if (outcome === 'paid') {
    const amount = toMoney(amountPaid) || toMoney(claim.billed_amount);
    await q("UPDATE claims SET paid_amount = $1, status = 'paid', updated_at = now() WHERE id = $2", [amount, claim.id]);
    await q("UPDATE denials SET status = 'appealed' WHERE claim_id = $1 AND status = 'open'", [claim.id]);
  } else if (outcome === 'denied') {
    await q("UPDATE claims SET status = 'denied', updated_at = now() WHERE id = $1", [claim.id]);
    const open = await q("SELECT id FROM denials WHERE claim_id = $1 AND status = 'open' LIMIT 1", [claim.id]);
    if (open.rows.length === 0) {
      await q(
        `INSERT INTO denials (clinic_id, claim_id, patient_id, denial_code, reason, status)
         VALUES ($1, $2, $3, $4, $5, 'open')`,
        [clinicId, claim.id, claim.patient_id, denialCode, statusAnswer || 'Denied per payer call']
      );
    }
  }
  // 'partial' / 'pending' / 'info-received': logged only, claim keeps its
  // status. A partial payment is recorded through ERA posting or
  // record-payment, not through a call outcome.

  const updatedClaim = (await q('SELECT * FROM claims WHERE id = $1', [claim.id])).rows[0];
  return { call, claim: updatedClaim };
}

module.exports = { OUTCOMES, applyCallOutcome };
