'use strict';

/**
 * Pass 5 verification test — public 7-day trial signup + clinic-scoped
 * access + pro auth screens. Runs the real Express app over HTTP against
 * an in-memory Postgres (pg-mem). No live DB, no network, no real data.
 *
 * Covers: public signup creates clinic (trial, ends in 7 days) + scoped
 * 'clinic' user + session cookie; duplicate email rejected; validation
 * (bad email, short password, missing clinic name); scoped user sees
 * only their own clinic (403 / empty for others), cannot see Costs &
 * Model, cannot create clinics or use the platform demo loader; BAA gate
 * still blocks real patient entry for a trial clinic until the BAA is
 * recorded (and the trial owner CAN record it); own subscription visible
 * and manageable; clinic-scoped sample data load/remove; rate limit
 * (5/hour per IP); bootstrap/first-run unchanged; normal login works.
 * Pass 5 follow-up: platform-owner clinic delete (DELETE /api/clinics/:id
 * surfaced by the Settings "Delete clinic" button) — empty clinic deleted
 * with its users + audit row; scoped users 403; clinic with billing
 * records 409 and stays; button exists in the UI, platform-owner-only.
 *
 * Run with: npm run test:pass5
 */

process.env.JWT_SECRET = 'test-secret-for-pass5-only';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  [ok] ${name}`);
}

async function main() {
  const db = newDb();
  db.public.registerFunction({
    name: 'char_length', args: ['text'], returns: 'int',
    implementation: (s) => (s === null || s === undefined ? null : [...s].length),
  });
  db.public.registerFunction({
    name: 'length', args: ['text'], returns: 'int',
    implementation: (s) => (s === null || s === undefined ? null : [...s].length),
  });
  const { Pool } = db.adapters.createPg();
  const memPool = new Pool();
  const dbMod = require('../src/db');
  dbMod.setPool(memPool);
  const { migrate } = require('../src/migrate');
  await migrate();
  console.log('[test] migrations applied to in-memory DB');

  const app = require('../src/index');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(method, path, body, useCookie, headers) {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (useCookie) h.Cookie = useCookie;
    const r = await fetch(base + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = r.headers.get('set-cookie');
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, json, setCookie: setCookie ? setCookie.split(';')[0] : null };
  }
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const ip = (n) => ({ 'X-Forwarded-For': `10.0.0.${n}` });

  // --- bootstrap (first-run) unchanged ------------------------------
  let r = await req('GET', '/health');
  check('health answers, version pass5', r.status === 200 && r.json.version === '0.5.0-pass5' && r.json.db === 'up');

  r = await req('GET', '/api/auth/status');
  check('no users yet (bootstrap mode)', r.json.usersExist === false);

  r = await req('POST', '/api/auth/register', { name: 'Zenvy Owner', email: 'owner@zenvydigitals.online', password: 'password123' });
  check('bootstrap owner created', r.status === 201 && r.json.user.role === 'owner' && r.json.user.clinic_id === null);
  const ownerCookie = r.setCookie;
  check('bootstrap register sets a session cookie', !!ownerCookie);

  r = await req('POST', '/api/auth/login', { email: 'owner@zenvydigitals.online', password: 'password123' });
  check('normal platform-owner login still works', r.status === 200 && !!r.setCookie);

  // --- public trial signup ------------------------------------------
  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'Bright Steps ABA', name: 'Sara Clinic', email: 'trial@brightsteps.com', password: 'password123' },
    null, ip(1));
  check('public signup creates trial clinic', r.status === 201 && r.json.clinic.name === 'Bright Steps ABA');
  check('trial ends in 7 days', r.json.trialEndsAt === d(7) && r.json.clinic.trial_ends_at === d(7));
  check('clinic is on the $500/mo plan, trialing', r.json.clinic.subscription_status === 'trial' && r.json.clinic.subscription_plan === 'platform-500');
  check('trial creates a clinic-scoped owner user', r.json.user.role === 'clinic' && r.json.user.clinic_id === r.json.clinic.id);
  check('public signup signs the trial user in', !!r.setCookie);
  const trialClinicId = r.json.clinic.id;
  const trialCookie = r.setCookie;

  r = await req('GET', '/api/auth/me', undefined, trialCookie);
  check('me works right after public signup', r.status === 200 && r.json.user.role === 'clinic' && r.json.user.clinic_id === trialClinicId);

  // --- one trial per email -------------------------------------------
  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'Other Clinic', name: 'Second Try', email: 'trial@brightsteps.com', password: 'password123' },
    null, ip(2));
  check('duplicate email rejected with a clear message', r.status === 400 && /already exists/.test(r.json.error || ''));

  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'Other Clinic', name: 'Second Try', email: 'owner@zenvydigitals.online', password: 'password123' },
    null, ip(2));
  check('platform owner email cannot take a trial either', r.status === 400 && /already exists/.test(r.json.error || ''));

  // --- validation -----------------------------------------------------
  r = await req('POST', '/api/public/start-trial', { clinicName: 'X', name: 'Y', email: 'not-an-email', password: 'password123' }, null, ip(3));
  check('bad email rejected', r.status === 400 && /email/i.test(r.json.error || ''));
  r = await req('POST', '/api/public/start-trial', { clinicName: 'X', name: 'Y', email: 'ok@example.com', password: 'short' }, null, ip(3));
  check('short password rejected', r.status === 400 && /8 characters/.test(r.json.error || ''));
  r = await req('POST', '/api/public/start-trial', { name: 'Y', email: 'ok2@example.com', password: 'password123' }, null, ip(3));
  check('missing clinic name rejected', r.status === 400 && /Clinic name/.test(r.json.error || ''));

  // --- a second clinic, owned by the platform owner -------------------
  r = await req('POST', '/api/clinics', { name: 'Second Clinic', state: 'OH' }, ownerCookie);
  check('platform owner creates a second clinic', r.status === 201);
  const otherClinicId = r.json.clinic.id;

  // --- clinic-scoped access ------------------------------------------
  r = await req('GET', '/api/clinics', undefined, trialCookie);
  check('scoped user lists only their own clinic', r.status === 200 && r.json.clinics.length === 1 && r.json.clinics[0].id === trialClinicId);
  r = await req('GET', `/api/clinics/${otherClinicId}`, undefined, trialCookie);
  check('scoped user cannot read another clinic', r.status === 403);
  r = await req('GET', `/api/clinics/${otherClinicId}/patients`, undefined, trialCookie);
  check('scoped user cannot read another clinic patients', r.status === 403);
  r = await req('POST', '/api/clinics', { name: 'Sneaky Clinic' }, trialCookie);
  check('scoped user cannot create clinics', r.status === 403);
  r = await req('GET', '/api/zenvy/costs', undefined, trialCookie);
  check('scoped user cannot see Costs & Model', r.status === 403);
  r = await req('POST', '/api/demo/load', {}, trialCookie);
  check('scoped user cannot use the platform demo loader', r.status === 403);
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, trialCookie);
  check('scoped user CAN read their own dashboard (sample data auto-loaded: 3 patients, $240 recovered)', r.status === 200 && r.json.dashboard.activePatients === 3 && r.json.dashboard.hasSampleData === true && r.json.dashboard.recoveredThisMonth === 240);
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, ownerCookie);
  check('platform owner still reads any dashboard', r.status === 200);

  // --- BAA gate still holds for a trial clinic ------------------------
  r = await req('POST', `/api/clinics/${trialClinicId}/patients`, { initials: 'J.D.', payer: 'BCBS', member_id: 'M-9' }, trialCookie);
  check('BAA gate blocks real patient entry for a trial clinic', r.status === 403 && /BAA/.test(r.json.error || ''));
  r = await req('PATCH', `/api/clinics/${trialClinicId}`, { baa_signed: true }, trialCookie);
  check('trial owner CAN record their own clinic BAA', r.status === 200 && r.json.clinic.baa_signed === true);
  r = await req('POST', `/api/clinics/${trialClinicId}/patients`, { initials: 'J.D.', payer: 'BCBS', member_id: 'M-9' }, trialCookie);
  check('patient entry works once the BAA is recorded', r.status === 201);

  // --- own subscription visible + manageable ---------------------------
  r = await req('GET', `/api/clinics/${trialClinicId}/subscription`, undefined, trialCookie);
  check('trial user sees own subscription (trial, ends in 7 days)', r.status === 200 && r.json.subscription.status === 'trial' && r.json.subscription.trialEndsAt === d(7));
  r = await req('POST', `/api/clinics/${trialClinicId}/subscription/pause`, {}, trialCookie);
  check('trial owner can pause their own subscription', r.status === 200 && r.json.subscription.status === 'paused');
  r = await req('POST', `/api/clinics/${trialClinicId}/subscription/resume`, {}, trialCookie);
  check('trial owner can resume their own subscription', r.status === 200 && r.json.subscription.status === 'trial');

  // --- clinic-scoped sample data --------------------------------------
  r = await req('POST', `/api/clinics/${trialClinicId}/demo/load`, {}, trialCookie);
  check('sample data already auto-loaded at signup (manual load refused)', r.status === 409);
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, trialCookie);
  check('sample data shows on the dashboard (recovered $240)', r.status === 200 && r.json.dashboard.hasSampleData === true && r.json.dashboard.recoveredThisMonth === 240);
  r = await req('POST', `/api/clinics/${trialClinicId}/demo/load`, {}, trialCookie);
  check('second sample load refused', r.status === 409);
  r = await req('POST', `/api/clinics/${trialClinicId}/demo/remove`, {}, trialCookie);
  check('sample data removes cleanly', r.status === 200 && r.json.removed.patients === 3);
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, trialCookie);
  check('dashboard clean after sample remove (real patient kept)', r.status === 200 && r.json.dashboard.hasSampleData === false && r.json.dashboard.activePatients === 1);
  r = await req('POST', `/api/clinics/${otherClinicId}/demo/load`, {}, trialCookie);
  check('scoped user cannot load sample data into another clinic', r.status === 403);

  // --- rate limit: 5/hour per IP --------------------------------------
  for (let i = 0; i < 5; i += 1) {
    r = await req('POST', '/api/public/start-trial', { clinicName: '', name: '', email: '', password: '' }, null, ip(9));
    check(`rate-limit attempt ${i + 1} counted, not blocked`, r.status === 400);
  }
  r = await req('POST', '/api/public/start-trial', { clinicName: '', name: '', email: '', password: '' }, null, ip(9));
  check('6th attempt in an hour is rate-limited', r.status === 429);

  // --- audit trail -----------------------------------------------------
  r = await req('GET', `/api/clinics/${trialClinicId}/audit?limit=500`, undefined, ownerCookie);
  const actions = new Set((r.json.audit || []).map((e) => e.action));
  check('audit log records public trial signup', r.status === 200 && actions.has('trial-start'));

  // --- delete clinic (Pass 5 follow-up: Settings button surfaces DELETE /api/clinics/:id) ---
  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'Delete Me Clinic', name: 'Temp Owner', email: 'deleteme@example.com', password: 'password123' },
    null, ip(20));
  check('empty trial clinic created for the delete test', r.status === 201);
  const deleteClinicId = r.json.clinic.id;
  const deleteUserCookie = r.setCookie;

  r = await req('DELETE', `/api/clinics/${deleteClinicId}`, undefined, trialCookie);
  check('clinic-scoped user cannot delete another clinic', r.status === 403);
  r = await req('DELETE', `/api/clinics/${deleteClinicId}`, undefined, deleteUserCookie);
  check('clinic-scoped user cannot delete even their own clinic', r.status === 403);

  r = await req('DELETE', `/api/clinics/${deleteClinicId}`, undefined, ownerCookie);
  check('platform owner deletes an empty clinic', r.status === 200 && r.json.deleted === true);
  r = await req('GET', `/api/clinics/${deleteClinicId}`, undefined, ownerCookie);
  check('deleted clinic is gone (404)', r.status === 404);
  r = await req('GET', '/api/clinics', undefined, ownerCookie);
  check('deleted clinic no longer listed', r.status === 200 && !(r.json.clinics || []).some((x) => x.id === deleteClinicId));
  r = await req('GET', '/api/auth/me', undefined, deleteUserCookie);
  check('deleted clinic user account is gone too', r.status === 401);
  r = await req('GET', `/api/clinics/${trialClinicId}/audit?limit=500`, undefined, ownerCookie);
  const deleteRows = (r.json.audit || []).filter((e) => e.action === 'delete' && e.entity === 'clinic' && e.entity_id === deleteClinicId);
  check('audit log records the clinic delete', r.status === 200 && deleteRows.length === 1);

  // a clinic holding billing records refuses with 409 and stays
  r = await req('POST', '/api/clinics', { name: 'Busy Clinic', state: 'TX' }, ownerCookie);
  check('clinic with future records created', r.status === 201);
  const busyClinicId = r.json.clinic.id;
  r = await req('PATCH', `/api/clinics/${busyClinicId}`, { baa_signed: true }, ownerCookie);
  check('BAA recorded for the busy clinic', r.status === 200 && r.json.clinic.baa_signed === true);
  r = await req('POST', `/api/clinics/${busyClinicId}/patients`, { initials: 'A.B.', payer: 'BCBS', member_id: 'M-1' }, ownerCookie);
  check('patient added to the busy clinic', r.status === 201);
  r = await req('DELETE', `/api/clinics/${busyClinicId}`, undefined, ownerCookie);
  check('clinic with billing records refuses with 409', r.status === 409 && /still holds data/.test(r.json.error || ''));
  r = await req('GET', `/api/clinics/${busyClinicId}`, undefined, ownerCookie);
  check('refused clinic is NOT deleted', r.status === 200 && r.json.clinic.id === busyClinicId);

  // the Settings button itself exists and is platform-owner-only in the UI
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('Settings has a Delete clinic button', /data-action="delete-clinic"/.test(appJs));
  check('Delete clinic button is gated to the Zenvy platform owner', /isZenvyOwner\(\) && c \?[\s\S]{0,600}delete-clinic/.test(appJs));

  server.close();
  console.log(`\n[test] pass5: ${passed} checks passed`);
}

main().catch((err) => {
  console.error('[test] pass5 FAILED:', err.message);
  process.exit(1);
});
