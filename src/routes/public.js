'use strict';

/**
 * Public trial signup (Pass 5) — no login required.
 *
 *   POST /api/public/start-trial
 *        { clinicName, name, email, password }
 *        → creates the clinic (status 'trial', 7-day trial on the
 *          $500/month plan) + a clinic-scoped owner account (role
 *          'clinic', clinic_id = the new clinic), signs them in
 *          (session cookie) and returns the clinic + trial end date.
 *          The website's Subscribe button links here:
 *          https://app.zenvydigitals.online/#trial
 *
 * ONE trial per email: an email that already has any account is
 * rejected with a plain message ("sign in instead").
 *
 * Anti-abuse (v1, simple): max 5 attempts per hour per IP, in-memory.
 * The client IP is the first X-Forwarded-For entry (Vercel sets it),
 * falling back to req.ip. Email format + password ≥ 8 chars are
 * validated like the normal register route.
 *
 * The hard BAA gate is untouched: a trial clinic still cannot enter
 * real patient data until its BAA is recorded (see routes/patients.js).
 */

const express = require('express');
const { query, getPool } = require('../db');
const { ApiError, cleanRow } = require('../util');
const { hashPassword, signToken, setSessionCookie } = require('../auth');
const { audit } = require('../audit');

const router = express.Router();

const TRIAL_DAYS = 7;
const PRICE_MONTHLY = 500;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const attemptsByIp = new Map(); // ip -> [timestamps]

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (attemptsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (list.length >= RATE_LIMIT_MAX) return true;
  list.push(now);
  attemptsByIp.set(ip, list);
  return false;
}

function trialEndsAt() {
  return new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString().slice(0, 10);
}

router.post('/start-trial', async (req, res, next) => {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      throw new ApiError(429, 'Too many trial signups from this address — please try again in an hour.');
    }

    const clinicName = String(req.body.clinicName || req.body.clinic_name || '').trim();
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!clinicName) throw new ApiError(400, 'Clinic name is required.');
    if (!name) throw new ApiError(400, 'Your name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'A valid work email address is required.');
    if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');

    // ONE trial per email — any existing account with this email blocks it.
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new ApiError(400, 'An account with that email already exists — sign in instead, or use a different work email.');
    }

    const endsAt = trialEndsAt();
    const pool = getPool();
    const client = await pool.connect();
    let clinic;
    let user;
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);
      clinic = (await q(
        `INSERT INTO clinics (name, contact_name, contact_email, subscription_status, subscription_plan, trial_ends_at)
         VALUES ($1, $2, $3, 'trial', 'platform-500', $4) RETURNING *`,
        [clinicName, name, email, endsAt]
      )).rows[0];
      const hash = await hashPassword(password);
      user = (await q(
        `INSERT INTO users (clinic_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'clinic') RETURNING id, clinic_id, name, email, role`,
        [clinic.id, name, email, hash]
      )).rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        throw new ApiError(400, 'An account with that email already exists — sign in instead, or use a different work email.');
      }
      throw err;
    } finally {
      client.release();
    }

    await audit(query, {
      actor: user, clinicId: clinic.id, entity: 'clinic', entityId: clinic.id,
      action: 'create', detail: { name: clinicName, source: 'public-trial' },
    });
    await audit(query, {
      actor: user, clinicId: clinic.id, entity: 'user', entityId: user.id,
      action: 'create', detail: { email, role: 'clinic', source: 'public-trial' },
    });
    await audit(query, {
      actor: user, clinicId: clinic.id, entity: 'subscription', entityId: clinic.id,
      action: 'trial-start',
      detail: { from: 'none', to: 'trial', trialDays: TRIAL_DAYS, priceMonthly: PRICE_MONTHLY, source: 'public-trial' },
    });

    setSessionCookie(res, signToken(user));
    res.status(201).json({
      ok: true,
      user: cleanRow(user),
      clinic: cleanRow(clinic, [], ['trial_ends_at']),
      trialEndsAt: endsAt,
      note: '7-day free trial started — no card required.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
