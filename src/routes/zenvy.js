'use strict';

/**
 * Zenvy platform-owner pages (Pass 3): Costs & Model.
 *
 * GET /api/zenvy/costs — owner-only AND Zenvy-platform-owner-only.
 * Hidden from every clinic user (owner, biller and viewer alike):
 * a clinic must never see what the platform costs Zenvy to run.
 * The numbers are the ones Rza was given when the platform was priced:
 * $500/month per clinic, Paddle 5% + $0.50 per payment, server and
 * email on free tiers to start, Sara calls $1–2 each (opt-in only).
 */

const express = require('express');
const { ApiError } = require('../util');
const { requireAuth } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

const COSTS = {
  priceMonthly: 500,
  trialDays: 7,
  monthlyCosts: [
    { item: 'Server — Render free tier now (DigitalOcean $20–50/mo later)', cost: '$0 now' },
    { item: 'Database — Supabase Free (500 MB, no expiry)', cost: '$0' },
    { item: 'Email alerts — Resend free tier (3,000 emails/month)', cost: '$0' },
    { item: 'Paddle fee — per $500 payment (5% + $0.50)', cost: '$25.50' },
    { item: 'Sara payer calls — opt-in clinics only, per call', cost: '$1–2' },
    { item: 'AI — Gemini free tier + Deepgram $200 free credit', cost: '$0 to start' },
  ],
  profit: [
    { clinics: 1, revenue: 500, paddleFees: 25.5, hosting: 0, net: 474.5, note: '≈ $440/mo after a small hosting share' },
    { clinics: 10, revenue: 5000, paddleFees: 255, hosting: 50, net: 4695, note: '≈ $4,600/mo' },
    { clinics: 20, revenue: 10000, paddleFees: 510, hosting: 50, net: 9440, note: '≈ $9,200/mo' },
  ],
  notes: [
    'No cost is charged before a clinic pays — Paddle only takes its fee from a real payment.',
    'The first paying clinic covers the server many times over; hosting is shared across clinics, so profit grows faster than cost.',
    'Sara calls only cost money for clinics that opt in — a clinic that never enables payer calls costs $0 in calls.',
    'Planning figures, not a promise — hosting moves to $20–50/mo on DigitalOcean once revenue starts.',
  ],
};

router.get('/costs', (req, res, next) => {
  if (req.user.role !== 'owner' || req.user.clinic_id !== null) {
    return next(new ApiError(403, 'Costs & Model is only visible to the Zenvy platform owner.'));
  }
  res.json({ ok: true, costs: COSTS });
});

module.exports = router;
