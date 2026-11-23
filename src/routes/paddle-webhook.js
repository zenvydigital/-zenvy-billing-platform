'use strict';

/**
 * Paddle webhook (Pass 3): POST /api/paddle/webhook.
 *
 * Mounted BEFORE the JSON body parser in src/index.js with
 * express.raw() so the signature can be verified against the exact
 * request bytes. If PADDLE_WEBHOOK_SECRET is not set, the endpoint
 * refuses with 503 — it never accepts an unverified event.
 *
 * Handled events (Paddle Billing):
 *   subscription.created / subscription.updated / subscription.paused /
 *   subscription.canceled — mapped onto the clinic's subscription_status
 *   using custom_data.clinic_id (set at checkout). past_due keeps the
 *   current status (Paddle retries the payment); anything else is
 *   acknowledged and ignored. Unknown clinics are acknowledged, not
 *   crashed — a webhook must never 500 on a mapping problem.
 */

const express = require('express');
const { query } = require('../db');
const { isoDate } = require('../util');
const { audit } = require('../audit');
const { verifyWebhookSignature, mapPaddleStatus } = require('../paddle');

const router = express.Router();

// Mounted at /api/paddle/webhook (see src/index.js) — this is POST / itself.
router.post('/', async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'Paddle webhook is not configured yet — set PADDLE_WEBHOOK_SECRET in the environment.' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const check = verifyWebhookSignature(raw, req.headers['paddle-signature']);
  if (!check.ok) {
    return res.status(401).json({ ok: false, error: check.error });
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'Webhook body is not valid JSON.' });
  }

  const type = event.event_type || '';
  const data = event.data || {};
  if (!type.startsWith('subscription.')) {
    return res.json({ ok: true, handled: false, note: `Event type ${type} is not a subscription event — acknowledged and ignored.` });
  }

  const clinicId = data.custom_data && data.custom_data.clinic_id
    ? Number(data.custom_data.clinic_id)
    : null;
  if (!clinicId) {
    return res.json({ ok: true, handled: false, note: 'No clinic_id in custom_data — cannot map this subscription to a clinic.' });
  }
  const { rows } = await query('SELECT * FROM clinics WHERE id = $1', [clinicId]);
  if (rows.length === 0) {
    return res.json({ ok: true, handled: false, note: `Clinic ${clinicId} does not exist — event acknowledged.` });
  }
  const clinic = rows[0];
  const next = mapPaddleStatus(data.status);
  if (next === null) {
    await audit(query, {
      actor: null, clinicId, entity: 'subscription', entityId: clinic.id,
      action: 'webhook', detail: { event_type: type, paddle_status: data.status, note: 'Status kept — Paddle is retrying payment.' },
    });
    return res.json({ ok: true, handled: true, status: clinic.subscription_status, note: `Paddle status '${data.status}' — clinic status kept.` });
  }

  let trialEndsAt = clinic.trial_ends_at;
  if (next === 'trial') {
    const ends = data.current_billing_period && data.current_billing_period.ends_at;
    trialEndsAt = ends ? isoDate(ends) : clinic.trial_ends_at;
  } else if (next === 'active') {
    trialEndsAt = null;
  }
  await query(
    `UPDATE clinics SET subscription_status = $1, trial_ends_at = $2,
       paddle_subscription_id = $3, paddle_customer_id = $4, updated_at = now()
     WHERE id = $5`,
    [next, trialEndsAt, data.id || null, data.customer_id || null, clinic.id]
  );
  await audit(query, {
    actor: null, clinicId, entity: 'subscription', entityId: clinic.id,
    action: 'webhook', detail: { event_type: type, paddle_status: data.status, from: clinic.subscription_status, to: next, paddle_subscription_id: data.id || null },
  });
  return res.json({ ok: true, handled: true, status: next });
});

module.exports = router;
