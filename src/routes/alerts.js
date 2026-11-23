'use strict';

/**
 * Alert digests (Pass 3): per-clinic digest history + manual send.
 *
 *   GET  /api/clinics/:clinicId/alert-digests   — digest rows, newest first
 *   POST /api/clinics/:clinicId/alerts/send-digest — compose + send today's
 *        digest now (owner only; alerts must be ON and an alert email set).
 *
 * Delivery status is recorded honestly: 'sent' only after Resend accepts
 * the email, 'failed' with the reason otherwise. A digest already sent
 * today is never sent twice.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, asJson, isoDate } = require('../util');
const { requireAuth, requireOwner, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { queueAndSendDigest } = require('../digest');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

function cleanDigest(d) {
  return {
    id: d.id,
    clinic_id: d.clinic_id,
    digest_date: isoDate(d.digest_date),
    items: asJson(d.items, []),
    itemCount: asJson(d.items, []).length,
    status: d.status,
    error: d.error,
    sent_at: d.sent_at ? new Date(d.sent_at).toISOString() : null,
    created_at: d.created_at ? new Date(d.created_at).toISOString() : null,
  };
}

router.get('/alert-digests', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const { rows } = await query(
      'SELECT * FROM alert_emails WHERE clinic_id = $1 ORDER BY digest_date DESC, id DESC LIMIT $2',
      [req.clinic.id, limit]
    );
    res.json({ ok: true, digests: rows.map(cleanDigest) });
  } catch (err) {
    next(err);
  }
});

router.post('/alerts/send-digest', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (!c.alerts_enabled) {
      throw new ApiError(409, 'Email alerts are off for this clinic — turn them on in Settings first.');
    }
    if (!c.alert_email) {
      throw new ApiError(400, 'No alert email address is set for this clinic — add one in Settings first.');
    }
    const result = await queueAndSendDigest(query, c);
    await audit(query, {
      actor: req.user, clinicId: c.id, entity: 'alert_digest',
      entityId: result.digest ? result.digest.id : null,
      action: 'send',
      detail: { digest_date: result.digest ? isoDate(result.digest.digest_date) : null, items: result.items.length, sent: result.sent, manual: true },
    });
    res.json({
      ok: true,
      digest: result.digest ? cleanDigest(result.digest) : null,
      sent: result.sent,
      items: result.items.length,
      note: result.note,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
