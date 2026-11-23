'use strict';

/**
 * Auth routes.
 *
 * Bootstrap: when NO users exist yet, POST /register creates the first
 * Zenvy platform owner (clinic_id NULL). After that, only an owner can
 * create accounts (for their clinic's billers/viewers).
 */

const express = require('express');
const { query } = require('../db');
const { ApiError, cleanRow } = require('../util');
const { hashPassword, checkPassword, signToken, setSessionCookie, clearSessionCookie } = require('../auth');
const { requireAuth, requireOwner } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();

function publicUser(u) {
  return cleanRow({ id: u.id, clinic_id: u.clinic_id, name: u.name, email: u.email, role: u.role });
}

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT count(*)::int AS n FROM users');
    res.json({ ok: true, usersExist: rows[0].n > 0, me: req.user ? publicUser(req.user) : null });
  } catch (err) {
    next(err);
  }
});

/** Create an account. Bootstrap (first user) OR owner-only afterwards. */
router.post('/register', async (req, res, next) => {
  try {
    const { rows: countRows } = await query('SELECT count(*)::int AS n FROM users');
    const isBootstrap = countRows[0].n === 0;

    let actor = null;
    if (!isBootstrap) {
      // Owner-only: reuse the auth guard inline (no session yet on this route).
      await new Promise((resolve, reject) => {
        requireAuth(req, res, (err) => (err ? reject(err) : resolve()));
      });
      if (req.user.role !== 'owner') {
        throw new ApiError(403, 'Only the clinic owner can create accounts.');
      }
      actor = req.user;
    }

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name) throw new ApiError(400, 'Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'A valid email address is required.');
    if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');

    let role = 'biller';
    let clinicId = null;
    if (isBootstrap) {
      role = 'owner';
    } else {
      if (!['owner', 'biller', 'viewer'].includes(req.body.role)) {
        throw new ApiError(400, 'Role must be owner, biller or viewer.');
      }
      role = req.body.role;
      // Clinic users belong to a clinic; a Zenvy owner has clinic_id NULL.
      if (req.body.clinic_id !== undefined && req.body.clinic_id !== null) {
        const c = await query('SELECT id FROM clinics WHERE id = $1', [req.body.clinic_id]);
        if (c.rows.length === 0) throw new ApiError(400, 'That clinic does not exist.');
        clinicId = req.body.clinic_id;
      }
      // A clinic-scoped owner can only create users inside their own clinic.
      if (actor && actor.clinic_id !== null) {
        if (clinicId !== actor.clinic_id) {
          throw new ApiError(403, 'You can only create accounts inside your own clinic.');
        }
        if (role === 'owner' && clinicId === null) {
          throw new ApiError(403, 'Clinic owners cannot create Zenvy platform owners.');
        }
      }
    }

    const hash = await hashPassword(password);
    let user;
    try {
      const ins = await query(
        `INSERT INTO users (clinic_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, clinic_id, name, email, role`,
        [clinicId, name, email, hash, role]
      );
      user = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') throw new ApiError(400, 'An account with that email already exists.');
      throw err;
    }
    await audit(query, {
      actor: actor || user,
      clinicId,
      entity: 'user',
      entityId: user.id,
      action: 'create',
      detail: { email, role, bootstrap: isBootstrap },
    });
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) throw new ApiError(401, 'Email or password is incorrect.');
    const user = rows[0];
    const ok = await checkPassword(password, user.password_hash);
    if (!ok) throw new ApiError(401, 'Email or password is incorrect.');
    setSessionCookie(res, signToken(user));
    await audit(query, {
      actor: user,
      clinicId: user.clinic_id,
      entity: 'user',
      entityId: user.id,
      action: 'login',
      detail: {},
    });
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

module.exports = router;
