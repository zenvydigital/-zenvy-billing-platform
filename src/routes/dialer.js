'use strict';

/**
 * Sara dialer bridge (Pass 4) — the handoff between this platform and
 * Sara's dialer (the free self-hosted calling build).
 *
 *   GET  /call-queue/export
 *        — the payer-call queue as a CSV download (claim, patient
 *          initials, payer, question, CPT, date of service, amount).
 *          The dialer reads this file to make its calls.
 *   POST /call-queue/import-results { results: [...] }
 *        — call outcomes back onto claims, with exactly the same rules
 *          as a call logged by hand (src/calls.js): paid → claim paid
 *          + open denials resolved; denied → claim denied + denial
 *          recorded; partial / pending / info-received → logged only.
 *          Each row is applied independently — one bad row never fails
 *          the whole import; failures are reported per row.
 *
 * Everything here is labelled simulation until Twilio live calling is
 * connected at deployment. The queue itself is opt-in only (creation
 * already enforces that); the export simply hands over what is queued.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, toCsv } = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { applyCallOutcome, OUTCOMES } = require('../calls');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

router.get('/call-queue/export', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT q.id AS queue_id, q.question, q.status AS queue_status,
              c.id AS claim_id, c.date_of_service, c.cpt_code, c.units, c.billed_amount,
              p.initials AS patient_initials, p.payer AS patient_payer
         FROM payer_call_queue q
         JOIN claims c ON c.id = q.claim_id
         JOIN patients p ON p.id = c.patient_id
        WHERE q.clinic_id = $1 AND q.status = 'queued'
        ORDER BY q.created_at ASC`,
      [req.clinic.id]
    );
    const headers = ['queue_id', 'claim_id', 'patient_initials', 'payer', 'date_of_service', 'cpt_code', 'units', 'billed_amount', 'question'];
    const csv = toCsv(headers, rows.map((r) => ({
      queue_id: r.queue_id,
      claim_id: r.claim_id,
      patient_initials: r.patient_initials,
      payer: r.patient_payer || '',
      date_of_service: r.date_of_service ? String(r.date_of_service).slice(0, 10) : '',
      cpt_code: r.cpt_code,
      units: r.units,
      billed_amount: r.billed_amount,
      question: r.question,
    })));
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sara-call-queue-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.post('/call-queue/import-results', requireWrite, async (req, res, next) => {
  try {
    const results = req.body.results;
    if (!Array.isArray(results) || results.length === 0) {
      throw new ApiError(400, 'Send call results as a JSON array: [{ queue_id or claim_id, outcome, status_answer, reference_number, amount_paid, denial_code }].');
    }
    const processed = [];
    const failed = [];
    for (let i = 0; i < results.length; i += 1) {
      const row = results[i];
      try {
        const outcome = String(row.outcome || '').trim();
        if (!OUTCOMES.includes(outcome)) {
          throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}.`);
        }
        let queueItem = null;
        let claim = null;
        if (row.queue_id) {
          const q = await query('SELECT * FROM payer_call_queue WHERE id = $1 AND clinic_id = $2', [row.queue_id, req.clinic.id]);
          if (q.rows.length === 0) throw new Error(`Queue item ${row.queue_id} not found in this clinic.`);
          queueItem = q.rows[0];
          if (queueItem.status !== 'queued' && queueItem.status !== 'processing') {
            throw new Error(`Queue item ${row.queue_id} is already ${queueItem.status}.`);
          }
          const c = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [queueItem.claim_id, req.clinic.id]);
          claim = c.rows[0];
        } else if (row.claim_id) {
          const c = await query('SELECT * FROM claims WHERE id = $1 AND clinic_id = $2', [row.claim_id, req.clinic.id]);
          if (c.rows.length === 0) throw new Error(`Claim ${row.claim_id} not found in this clinic.`);
          claim = c.rows[0];
        } else {
          throw new Error('Each result needs a queue_id or a claim_id.');
        }
        if (!claim) throw new Error('The queued claim no longer exists.');
        const { call, claim: updatedClaim } = await applyCallOutcome(query, req.clinic.id, claim, {
          caller: 'sara',
          outcome,
          statusAnswer: row.status_answer || null,
          referenceNumber: row.reference_number || null,
          nextAction: row.next_action || null,
          amountPaid: row.amount_paid !== undefined ? row.amount_paid : null,
          denialCode: row.denial_code || null,
          queueId: queueItem ? queueItem.id : null,
        });
        await audit(query, {
          actor: req.user, clinicId: req.clinic.id, entity: 'payer_call', entityId: call.id,
          action: 'create', detail: { claim_id: claim.id, outcome, caller: 'sara', source: 'dialer-import', simulation: true },
        });
        processed.push({
          row: i + 1,
          queueId: queueItem ? queueItem.id : null,
          claimId: claim.id,
          outcome,
          claimStatus: updatedClaim.status,
          paidAmount: updatedClaim.paid_amount,
        });
      } catch (err) {
        failed.push({ row: i + 1, queueId: row.queue_id || null, claimId: row.claim_id || null, error: err.message });
      }
    }
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'payer_call', entityId: null,
      action: 'dialer-import', detail: { processed: processed.length, failed: failed.length },
    });
    res.json({
      ok: true,
      simulation: true,
      simulationNote: 'Simulation mode — no live Twilio calls were placed. These outcomes came from the dialer results file.',
      summary: { processed: processed.length, failed: failed.length },
      processed,
      failed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
