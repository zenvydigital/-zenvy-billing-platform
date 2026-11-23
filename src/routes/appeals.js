'use strict';

/**
 * Appeal drafts (Pass 4).
 *
 *   POST /denials/:denialId/appeal-draft
 *        — generate a payer-specific draft from the denial (template
 *          picked by payer + denial code; generic fallback).
 *   GET  /appeal-drafts            — list drafts for this clinic
 *   GET  /appeal-drafts/:id       — one draft
 *   GET  /appeal-drafts/:id/download — the letter as a .txt download
 *   PATCH /appeal-drafts/:id      — edit the text (merge), or mark ready
 *   POST /appeal-drafts/:id/file  — mark filed → denial becomes 'appealing'
 *   DELETE /appeal-drafts/:id     — delete the draft only, never the denial
 *
 * A draft is a starting point, not a legal letter — the biller edits it
 * before filing. Drafts are clinic-scoped and audited like everything else.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, applyMerge, toMoney, isoDate } = require('../util');
const { requireAuth, requireWrite, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { buildAppealDraft } = require('../appeals');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

function cleanDraft(d) {
  return cleanRow(d, [], []);
}

async function loadDenialWithClaim(clinicId, denialId) {
  const { rows } = await query(
    `SELECT d.*, c.date_of_service, c.cpt_code, c.units, c.billed_amount, c.authorization_id,
            c.payer_claim_number, p.initials AS patient_initials, p.payer AS patient_payer,
            a.auth_number
       FROM denials d
       JOIN claims c ON c.id = d.claim_id
       JOIN patients p ON p.id = d.patient_id
       LEFT JOIN authorizations a ON a.id = c.authorization_id
      WHERE d.id = $1 AND d.clinic_id = $2`,
    [denialId, clinicId]
  );
  return rows[0] || null;
}

router.post('/denials/:denialId/appeal-draft', requireWrite, async (req, res, next) => {
  try {
    const denial = await loadDenialWithClaim(req.clinic.id, req.params.denialId);
    if (!denial) throw new ApiError(404, 'Denial not found in this clinic.');
    if (denial.status === 'written-off') {
      throw new ApiError(409, 'This denial was written off — it cannot be appealed.');
    }
    const ctx = {
      clinicName: req.clinic.name,
      clinicCity: req.clinic.city,
      clinicState: req.clinic.state,
      clinicEmail: req.clinic.contact_email,
      today: new Date().toISOString().slice(0, 10),
      claimId: denial.claim_id,
      patientInitials: denial.patient_initials,
      dateOfService: isoDate(denial.date_of_service),
      cptCode: denial.cpt_code,
      units: denial.units || 0,
      billedAmount: toMoney(denial.billed_amount).toFixed(2),
      payer: denial.patient_payer || 'the payer',
      denialCode: denial.denial_code,
      denialReason: denial.reason,
      authNumber: denial.auth_number,
    };
    const { template, label, draftText } = buildAppealDraft(ctx);
    const ins = await query(
      `INSERT INTO appeal_drafts (denial_id, claim_id, payer, template, draft_text, status)
       VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
      [denial.id, denial.claim_id, ctx.payer, template, draftText]
    );
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'appeal_draft', entityId: ins.rows[0].id,
      action: 'create', detail: { denial_id: denial.id, claim_id: denial.claim_id, template, template_label: label },
    });
    res.status(201).json({ ok: true, draft: cleanDraft(ins.rows[0]), template, templateLabel: label });
  } catch (err) {
    next(err);
  }
});

router.get('/appeal-drafts', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.*, d.denial_code, d.status AS denial_status, d.appeal_deadline,
              c.date_of_service, c.cpt_code, p.initials AS patient_initials
         FROM appeal_drafts ad
         JOIN denials d ON d.id = ad.denial_id
         JOIN claims c ON c.id = ad.claim_id
         JOIN patients p ON p.id = c.patient_id
        WHERE c.clinic_id = $1
        ORDER BY ad.created_at DESC`,
      [req.clinic.id]
    );
    res.json({ ok: true, drafts: rows.map((r) => cleanRow(r, [], ['appeal_deadline', 'date_of_service'])) });
  } catch (err) {
    next(err);
  }
});

router.get('/appeal-drafts/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.* FROM appeal_drafts ad JOIN claims c ON c.id = ad.claim_id
        WHERE ad.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Appeal draft not found.');
    res.json({ ok: true, draft: cleanDraft(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.get('/appeal-drafts/:id/download', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.* FROM appeal_drafts ad JOIN claims c ON c.id = ad.claim_id
        WHERE ad.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Appeal draft not found.');
    const draft = rows[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="appeal-claim-${draft.claim_id}-draft-${draft.id}.txt"`);
    res.send(draft.draft_text);
  } catch (err) {
    next(err);
  }
});

router.patch('/appeal-drafts/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.* FROM appeal_drafts ad JOIN claims c ON c.id = ad.claim_id
        WHERE ad.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Appeal draft not found.');
    const draft = rows[0];
    if (draft.status === 'filed') {
      throw new ApiError(409, 'This draft was already filed — filed drafts cannot be edited.');
    }
    if (req.body.status !== undefined && !['draft', 'ready'].includes(req.body.status)) {
      throw new ApiError(400, "Status must be draft or ready (use the file action to mark a draft filed).");
    }
    const updated = await applyMerge(query, 'appeal_drafts', draft, ['draft_text', 'status'], req.body);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'appeal_draft', entityId: updated.id, action: 'update', detail: { changed: Object.keys(req.body) } });
    res.json({ ok: true, draft: cleanDraft(updated) });
  } catch (err) {
    next(err);
  }
});

/** Mark a draft filed — the denial moves to 'appealing'. */
router.post('/appeal-drafts/:id/file', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.* FROM appeal_drafts ad JOIN claims c ON c.id = ad.claim_id
        WHERE ad.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Appeal draft not found.');
    const draft = rows[0];
    if (draft.status === 'filed') {
      throw new ApiError(409, 'This draft was already filed.');
    }
    const updated = await query(
      "UPDATE appeal_drafts SET status = 'filed', updated_at = now() WHERE id = $1 RETURNING *",
      [draft.id]
    );
    await query("UPDATE denials SET status = 'appealing', updated_at = now() WHERE id = $1 AND status IN ('open', 'appealed')", [draft.denial_id]);
    const denial = (await query('SELECT * FROM denials WHERE id = $1', [draft.denial_id])).rows[0];
    await audit(query, {
      actor: req.user, clinicId: req.clinic.id, entity: 'appeal_draft', entityId: draft.id,
      action: 'file', detail: { denial_id: draft.denial_id, denial_status: denial ? denial.status : null },
    });
    res.json({ ok: true, draft: cleanDraft(updated.rows[0]), denialStatus: denial ? denial.status : null });
  } catch (err) {
    next(err);
  }
});

/** Delete a draft — the denial itself is never deleted with it. */
router.delete('/appeal-drafts/:id', requireWrite, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ad.* FROM appeal_drafts ad JOIN claims c ON c.id = ad.claim_id
        WHERE ad.id = $1 AND c.clinic_id = $2`,
      [req.params.id, req.clinic.id]
    );
    if (rows.length === 0) throw new ApiError(404, 'Appeal draft not found.');
    await query('DELETE FROM appeal_drafts WHERE id = $1', [rows[0].id]);
    await audit(query, { actor: req.user, clinicId: req.clinic.id, entity: 'appeal_draft', entityId: rows[0].id, action: 'delete', detail: { denial_id: rows[0].denial_id } });
    res.json({ ok: true, deleted: true, note: 'The denial itself was kept — only the draft was deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
