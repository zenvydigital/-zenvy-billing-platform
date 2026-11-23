'use strict';

/**
 * Request guards: authentication, role enforcement, clinic scoping.
 *
 * Roles (server-enforced on every route):
 *   owner  — Zenvy platform owner (clinic_id NULL): everything, all clinics.
 *            A clinic-scoped user can also carry role 'owner' for their own
 *            clinic (created by the platform owner) — loadClinic still
 *            confines them to that clinic.
 *   clinic — clinic owner created by public trial signup (Pass 5): owns
 *            exactly one clinic, manages it fully, but never sees other
 *            clinics, Costs & Model, or platform administration.
 *   biller — works billing inside their own clinic
 *   viewer — read-only; every write is rejected with a plain message
 */

const { query } = require('./db');
const { ApiError } = require('./util');
const { parseCookies, verifyToken, COOKIE_NAME } = require('./auth');

/** Attach req.user from the session cookie; 401 when missing/invalid. */
async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) throw new ApiError(401, 'Please sign in to use the platform.');
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new ApiError(401, 'Your session has expired — please sign in again.');
    }
    const { rows } = await query('SELECT id, clinic_id, name, email, role FROM users WHERE id = $1', [payload.uid]);
    if (rows.length === 0) throw new ApiError(401, 'Your account no longer exists — please sign in again.');
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/** Writes need owner or biller. Viewers get a plain-language refusal. */
function requireWrite(req, res, next) {
  if (req.user.role === 'viewer') {
    return next(new ApiError(403, 'Viewer accounts are read-only — ask your clinic owner for a Biller login to make changes.'));
  }
  return next();
}

/** Owner only (clinic flags, user management, demo data, settings). */
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') {
    return next(new ApiError(403, 'Only the clinic owner can do this.'));
  }
  return next();
}

/**
 * Zenvy platform owner only: role 'owner' AND clinic_id NULL. Clinic
 * users — including clinic-scoped owners (role 'owner' with a clinic_id,
 * and role 'clinic') — never pass this, so they can never create/delete
 * clinics, see Costs & Model, or touch platform administration.
 */
function requirePlatformOwner(req, res, next) {
  if (req.user.role !== 'owner' || req.user.clinic_id !== null) {
    return next(new ApiError(403, 'Only the Zenvy platform owner can do this.'));
  }
  return next();
}

/**
 * Owner of a clinic: role 'owner' or role 'clinic'. The clinic itself is
 * already confined by loadClinic (a scoped user only ever touches their
 * own clinic), so this is safe for clinic settings, subscription
 * management, user management inside the clinic, and alert digests.
 */
function requireClinicOwner(req, res, next) {
  if (req.user.role !== 'owner' && req.user.role !== 'clinic') {
    return next(new ApiError(403, 'Only the clinic owner can do this.'));
  }
  return next();
}

/**
 * Load :clinicId and check the caller may touch it. Zenvy owners
 * (clinic_id NULL) may access any clinic; clinic users only their own.
 */
async function loadClinic(req, res, next) {
  try {
    const { rows } = await query('SELECT * FROM clinics WHERE id = $1', [req.params.clinicId]);
    if (rows.length === 0) throw new ApiError(404, 'Clinic not found.');
    const clinic = rows[0];
    if (req.user.clinic_id !== null && req.user.clinic_id !== clinic.id) {
      throw new ApiError(403, 'You can only access your own clinic’s data.');
    }
    req.clinic = clinic;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireWrite, requireOwner, requirePlatformOwner, requireClinicOwner, loadClinic };
