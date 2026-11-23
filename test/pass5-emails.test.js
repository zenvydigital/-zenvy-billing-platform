'use strict';

/**
 * Pass 5 follow-up #2 verification — trial signup emails + auto-loaded
 * sample data. Runs the real Express app over HTTP against an in-memory
 * Postgres (pg-mem). No live DB, no real email.
 *
 * Covers:
 *   - No-key path: with RESEND_API_KEY unset, signup still returns 201
 *     (emails skipped, logged, never blocking the signup).
 *   - A new trial clinic has sample data present right after signup:
 *     dashboard hasSampleData + recovered $240, 3 is_demo patients,
 *     4 is_demo claims, 1 open CO-97 denial — and the BAA gate still
 *     blocks real patient entry.
 *   - Manual sample load after auto-load is refused (409); remove works
 *     and the dashboard goes clean.
 *   - Non-trial clinics (created by the platform owner) do NOT get
 *     sample data auto-loaded.
 *   - With a stubbed Resend + fake key, exactly two emails are sent:
 *     welcome to the clinic's work email (7 days, trial end date,
 *     sample data already loaded) and notification to
 *     billing@zenvydigitals.online (clinic, contact, email, time);
 *     the 201 response reports emailsSent honestly.
 *   - With Resend rejecting (401), signup still returns 201 and
 *     emailsSent reports both as failed — the failure never breaks
 *     the signup.
 *   - Duplicate-email and rate-limit behaviour unchanged.
 *
 * Run with: node --test test/pass5-emails.test.js
 * (also works as: node test/pass5-emails.test.js)
 */

process.env.JWT_SECRET = 'test-secret-for-pass5-emails-only';
process.env.NODE_ENV = 'test';
delete process.env.RESEND_API_KEY;

const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');

const realFetch = global.fetch;

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
    const r = await realFetch(base + path, {
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

  // --- bootstrap ------------------------------------------------------
  let r = await req('GET', '/health');
  check('health answers, version pass5', r.status === 200 && r.json.version === '0.5.0-pass5' && r.json.db === 'up');

  r = await req('POST', '/api/auth/register', { name: 'Zenvy Owner', email: 'owner@zenvydigitals.online', password: 'password123' });
  check('bootstrap owner created', r.status === 201 && r.json.user.role === 'owner');
  const ownerCookie = r.setCookie;

  // --- Phase A: no Resend key — signup still 201 ----------------------
  check('RESEND_API_KEY is unset for the no-key phase', !process.env.RESEND_API_KEY);
  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'No Key Clinic', name: 'Ana NoKey', email: 'nokey@example.com', password: 'password123' },
    null, ip(1));
  check('signup returns 201 with no Resend key', r.status === 201 && r.json.clinic.subscription_status === 'trial');
  check('no-key signup reports emails as not sent (honest)', r.status === 201 && r.json.emailsSent && r.json.emailsSent.welcome === false && r.json.emailsSent.notify === false);
  check('no-key signup reports sample data loaded', r.status === 201 && r.json.sampleDataLoaded === true);
  const trialClinicId = r.json.clinic.id;
  const trialCookie = r.setCookie;

  // --- sample data is present right after signup -----------------------
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, trialCookie);
  check('dashboard shows sample data loaded (hasSampleData)', r.status === 200 && r.json.dashboard.hasSampleData === true);
  check('dashboard shows recovered $240 from the sample paid claim', r.status === 200 && r.json.dashboard.recoveredThisMonth === 240);
  check('dashboard counts the sample claims + patients', r.status === 200 && r.json.dashboard.totalClaims === 4 && r.json.dashboard.activePatients === 3);
  check('dashboard shows the open sample denial', r.status === 200 && r.json.dashboard.openDenials === 1);

  r = await req('GET', `/api/clinics/${trialClinicId}/patients`, undefined, trialCookie);
  check('3 sample patients present, all is_demo', r.status === 200 && r.json.patients.length === 3 && r.json.patients.every((p) => p.is_demo === true));
  r = await req('GET', `/api/clinics/${trialClinicId}/claims`, undefined, trialCookie);
  check('4 sample claims present, all is_demo', r.status === 200 && r.json.claims.length === 4 && r.json.claims.every((c) => c.is_demo === true));
  r = await req('GET', `/api/clinics/${trialClinicId}/denials`, undefined, trialCookie);
  check('1 open sample denial (CO-97) present', r.status === 200 && r.json.denials.length === 1 && r.json.denials[0].denial_code === 'CO-97' && r.json.denials[0].status === 'open');

  // --- BAA gate still holds for the trial clinic -----------------------
  r = await req('POST', `/api/clinics/${trialClinicId}/patients`, { initials: 'J.D.', payer: 'BCBS', member_id: 'M-9' }, trialCookie);
  check('BAA gate still blocks real patient entry (sample data does not lift it)', r.status === 403 && /BAA/.test(r.json.error || ''));

  // --- manual load/remove still behave ---------------------------------
  r = await req('POST', `/api/clinics/${trialClinicId}/demo/load`, {}, trialCookie);
  check('manual sample load after auto-load is refused (409)', r.status === 409);
  r = await req('POST', `/api/clinics/${trialClinicId}/demo/remove`, {}, trialCookie);
  check('sample data removes cleanly', r.status === 200 && r.json.removed.patients === 3);
  r = await req('GET', `/api/clinics/${trialClinicId}/dashboard`, undefined, trialCookie);
  check('dashboard clean after sample remove', r.status === 200 && r.json.dashboard.hasSampleData === false && r.json.dashboard.totalClaims === 0);

  // --- non-trial clinics do NOT get sample data -------------------------
  r = await req('POST', '/api/clinics', { name: 'Plain Clinic', state: 'OH' }, ownerCookie);
  check('platform owner creates a plain clinic', r.status === 201);
  const plainClinicId = r.json.clinic.id;
  r = await req('GET', `/api/clinics/${plainClinicId}/dashboard`, undefined, ownerCookie);
  check('plain (non-trial) clinic starts empty — no auto sample data', r.status === 200 && r.json.dashboard.hasSampleData === false && r.json.dashboard.totalClaims === 0);

  // --- duplicate email + rate limit unchanged ---------------------------
  r = await req('POST', '/api/public/start-trial',
    { clinicName: 'Other Clinic', name: 'Second Try', email: 'nokey@example.com', password: 'password123' },
    null, ip(2));
  check('duplicate email rejected with a clear message', r.status === 400 && /already exists/.test(r.json.error || ''));
  for (let i = 0; i < 5; i += 1) {
    r = await req('POST', '/api/public/start-trial', { clinicName: '', name: '', email: '', password: '' }, null, ip(9));
    check(`rate-limit attempt ${i + 1} counted, not blocked`, r.status === 400);
  }
  r = await req('POST', '/api/public/start-trial', { clinicName: '', name: '', email: '', password: '' }, null, ip(9));
  check('6th attempt in an hour is rate-limited', r.status === 429);

  // --- Phase B: stubbed Resend — both emails sent -----------------------
  process.env.RESEND_API_KEY = 're_test_key_for_pass5_emails';
  const resendCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const body = JSON.parse(opts.body);
      resendCalls.push({ url: String(url), to: body.to, subject: body.subject, html: body.html, from: body.from });
      return { ok: true, status: 200, json: async () => ({ id: 're_test123' }) };
    }
    return realFetch(url, opts);
  };
  try {
    r = await req('POST', '/api/public/start-trial',
      { clinicName: 'Mailed Clinic', name: 'Mia Mailed', email: 'mailed@example.com', password: 'password123' },
      null, ip(3));
    check('signup with Resend key returns 201', r.status === 201 && r.json.clinic.subscription_status === 'trial');
    check('signup reports both emails as sent', r.status === 201 && r.json.emailsSent && r.json.emailsSent.welcome === true && r.json.emailsSent.notify === true);
    check('exactly two Resend calls were made', resendCalls.length === 2);
    const welcome = resendCalls.find((c) => (c.to || []).includes('mailed@example.com'));
    const notify = resendCalls.find((c) => (c.to || []).includes('billing@zenvydigitals.online'));
    check('welcome email goes to the clinic work email', !!welcome);
    check('welcome subject names the trial', !!welcome && /trial/i.test(welcome.subject));
    check('welcome body has the 7-day trial end date', !!welcome && welcome.html.includes(d(7)));
    check('welcome body says sample data is already loaded', !!welcome && /Sample data is already loaded/.test(welcome.html));
    check('welcome body points at billing@zenvydigitals.online for help', !!welcome && welcome.html.includes('billing@zenvydigitals.online'));
    check('notification email goes to Zenvy', !!notify);
    check('notification subject names the new clinic', !!notify && notify.subject.includes('Mailed Clinic'));
    check('notification body has clinic, contact, email and time', !!notify
      && notify.html.includes('Mailed Clinic') && notify.html.includes('Mia Mailed')
      && notify.html.includes('mailed@example.com') && /Started:/.test(notify.html));
    check('both emails sent from the Zenvy sender', resendCalls.every((c) => c.from && c.from.includes('billing@zenvydigitals.online')));

    // --- Phase C: Resend rejects — signup still 201 --------------------
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://api.resend.com/')) {
        return { ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) };
      }
      return realFetch(url, opts);
    };
    r = await req('POST', '/api/public/start-trial',
      { clinicName: 'Rejected Clinic', name: 'Rex Rejected', email: 'rejected@example.com', password: 'password123' },
      null, ip(4));
    check('signup still returns 201 when Resend rejects', r.status === 201 && r.json.clinic.subscription_status === 'trial');
    check('rejected sends reported as not sent (honest)', r.status === 201 && r.json.emailsSent && r.json.emailsSent.welcome === false && r.json.emailsSent.notify === false);
    check('sample data still loaded when emails fail', r.status === 201 && r.json.sampleDataLoaded === true);
  } finally {
    global.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }

  server.close();
  console.log(`\n[test] pass5-emails: ${passed} checks passed`);
}

main().catch((err) => {
  global.fetch = realFetch;
  console.error('[test] pass5-emails FAILED:', err.message);
  process.exit(1);
});
