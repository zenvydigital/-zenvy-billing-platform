'use strict';

/**
 * Subscriptions (Pass 3): $500/month per clinic, 14-day free trial, no card.
 *
 * Lifecycle per clinic (all owner-only, all recorded in the audit log):
 *   none → trial (14 days) → active → paused → active (resume)
 *   any of trial / active / paused → cancelled (month-to-month, cancel anytime)
 *   cancelled → trial / active again (re-subscribe)
 *
 * Paddle is the payment processor (sandbox first, clearly labelled).
 * Until Paddle is connected these endpoints are the honest stand-in:
 * they record the lifecycle the clinic agreed to, and the Paddle webhook
 * (routes/paddle-webhook.js) takes over once live. No card data is ever
 * stored here.
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow, isoDate } = require('../util');
const { requireAuth, requireWrite, requireOwner, loadClinic } = require('../middleware');
const { audit } = require('../audit');
const { paddleMode, paddleConfigured } = require('../paddle');

const router = express.Router({ mergeParams: true });
router.use(requireAuth, loadClinic);

const PRICE_MONTHLY = 500;
const TRIAL_DAYS = 14;

function todayPlus(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function subView(clinic) {
  return cleanRow(
    {
      clinic_id: clinic.id,
      clinic: clinic.name,
      status: clinic.subscription_status,
      plan: clinic.subscription_plan,
      priceMonthly: PRICE_MONTHLY,
      trialDays: TRIAL_DAYS,
      trialEndsAt: clinic.trial_ends_at,
      paddleCustomerId: clinic.paddle_customer_id,
      paddleSubscriptionId: clinic.paddle_subscription_id,
      paddle: { mode: paddleMode(), configured: paddleConfigured() },
    },
    [],
    ['trialEndsAt']
  );
}

async function setSubscription(req, clinic, nextStatus, { trialEndsAt, action, detail }) {
  const newTrialEnds = trialEndsAt === undefined ? clinic.trial_ends_at : trialEndsAt;
  const { rows } = await query(
    `UPDATE clinics SET subscription_status = $1, trial_ends_at = $2, updated_at = now()
      WHERE id = $3 RETURNING *`,
    [nextStatus, newTrialEnds, clinic.id]
  );
  const updated = rows[0];
  await audit(query, {
    actor: req.user,
    clinicId: clinic.id,
    entity: 'subscription',
    entityId: clinic.id,
    action,
    detail: { from: clinic.subscription_status, to: nextStatus, ...(detail || {}) },
  });
  return updated;
}

router.get('/', (req, res) => {
  res.json({ ok: true, subscription: subView(req.clinic) });
});

/** Start the 14-day free trial (no card). */
router.post('/trial', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (c.subscription_status === 'trial') {
      throw new ApiError(409, 'This clinic is already on its free trial.');
    }
    if (c.subscription_status === 'active') {
      throw new ApiError(409, 'This clinic already has an active subscription — no trial needed.');
    }
    if (c.subscription_status === 'paused') {
      throw new ApiError(409, 'This clinic is paused — resume it instead of starting a new trial.');
    }
    const updated = await setSubscription(req, c, 'trial', {
      trialEndsAt: todayPlus(TRIAL_DAYS),
      action: 'trial-start',
      detail: { trialDays: TRIAL_DAYS, priceMonthly: PRICE_MONTHLY },
    });
    res.status(201).json({ ok: true, subscription: subView(updated), note: '14-day free trial started — no card required.' });
  } catch (err) {
    next(err);
  }
});

/** Activate the $500/month subscription (after trial, or re-subscribe). */
router.post('/activate', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (c.subscription_status === 'active') {
      throw new ApiError(409, 'This clinic already has an active subscription.');
    }
    const updated = await setSubscription(req, c, 'active', {
      trialEndsAt: null,
      action: 'activate',
      detail: { priceMonthly: PRICE_MONTHLY, paddleMode: paddleMode() },
    });
    res.json({ ok: true, subscription: subView(updated), note: 'Subscription active — $500/month, month-to-month.' });
  } catch (err) {
    next(err);
  }
});

/** Pause billing (trial or active). Access returns on resume. */
router.post('/pause', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (!['trial', 'active'].includes(c.subscription_status)) {
      throw new ApiError(409, `Only a trial or active subscription can be paused (current: ${c.subscription_status}).`);
    }
    const updated = await setSubscription(req, c, 'paused', { action: 'pause', detail: {} });
    res.json({ ok: true, subscription: subView(updated), note: 'Subscription paused — resume any time.' });
  } catch (err) {
    next(err);
  }
});

/** Resume a paused subscription (back to trial if the trial had not ended). */
router.post('/resume', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (c.subscription_status !== 'paused') {
      throw new ApiError(409, `Only a paused subscription can be resumed (current: ${c.subscription_status}).`);
    }
    const stillTrial = c.trial_ends_at && isoDate(c.trial_ends_at) >= todayPlus(0);
    const updated = await setSubscription(req, c, stillTrial ? 'trial' : 'active', {
      action: 'resume',
      detail: { resumedTo: stillTrial ? 'trial' : 'active' },
    });
    res.json({ ok: true, subscription: subView(updated), note: stillTrial ? 'Trial resumed.' : 'Subscription resumed — active.' });
  } catch (err) {
    next(err);
  }
});

/** Cancel (month-to-month, cancel anytime). */
router.post('/cancel', requireOwner, async (req, res, next) => {
  try {
    const c = req.clinic;
    if (c.subscription_status === 'cancelled') {
      throw new ApiError(409, 'This subscription is already cancelled.');
    }
    if (c.subscription_status === 'none') {
      throw new ApiError(409, 'There is no subscription to cancel.');
    }
    const updated = await setSubscription(req, c, 'cancelled', { action: 'cancel', detail: {} });
    res.json({ ok: true, subscription: subView(updated), note: 'Subscription cancelled — the clinic can re-subscribe any time, and its data can be exported first.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
