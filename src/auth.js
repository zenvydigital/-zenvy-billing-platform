'use strict';

/**
 * Auth: bcrypt passwords, JWT in an httpOnly cookie.
 *
 * Sessions last 12 hours. The JWT secret comes from JWT_SECRET (Render
 * generates it on deploy). If it is missing outside production, a dev-only
 * fallback is used and a loud warning is printed — never ship with it.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'zenvy_session';
const SESSION_TTL = '12h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s !== 'change-me-to-a-long-random-string') return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not set — refusing to sign sessions in production.');
  }
  console.warn('[auth] WARNING: JWT_SECRET is not set — using a dev-only fallback secret.');
  return 'dev-only-secret-do-not-use-in-production';
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, clinic_id: user.clinic_id ?? null, name: user.name },
    getSecret(),
    { expiresIn: SESSION_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  checkPassword,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
};
