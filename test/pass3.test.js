'use strict';

/**
 * Pass 3 verification test — subscriptions (Paddle), email alert digests
 * (Resend), automation rules + daily sweep, Costs & Model.
 *
 * Runs the full API against an in-memory Postgres (pg-mem) + the real
 * Express app over HTTP. No live DB, no network, no real keys, no real
 * data. Resend is deliberately unconfigured here, so delivery is
 * recorded as failed with the honest reason — never assumed.
 *
 * Run with: npm run test:pass3
 */

process.env.JWT_SECRET = 'test-secret-for-pass3-only';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

  let cookie = '';
  async function req(method, path, body, useCookie, extraHeaders) {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    const c = useCookie !== undefined ? useCookie : cookie;
    if (c) headers.Cookie = c;
    const r = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, json, raw: r };
  }
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // --- bootstrap ------------------------------------------------------
  let r = await req('GET', '/health');
  check('health answers, db up, version pass5', r.status === 200 && r.json.ok && r.json.db === 'up' && r.json.version === '0.5.0-pass5');

  r = await req('POST', '/api/auth/register', { name: 'Zenvy Owner', email: 'owner@zenvydigitals.online', password: 'password123' });
  check('bootstrap owner created', r.status === 201);
  r = await req('POST', '/api/auth/login', { email: 'owner@zenvydigitals.online', password: 'password123' });
  check('owner login works', r.status === 200 && !!cookie);
  const ownerCookie = cookie;

  r = await req('POST', '/api/clinics', { name: 'Test Clinic P3', city: 'Columbus', state: 'OH' });
  check('clinic created', r.status === 201);
  const clinicId = r.json.clinic.id;

  r = await req('PATCH', `/api/clinics/${clinicId}`, { baa_signed: true });
  check('BAA recorded', r.status === 200 && r.json.clinic.baa_signed === true);

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'T.K.', payer: 'Aetna', member_id: 'M-1' });
  check('patient T.K. created', r.status === 201);
  const tkId = r.json.patient.id;

  r = await req('POST', `/api/clinics/${clinicId}/verifications`, { patient_id: tkId, payer: 'Aetna', status: 'pending', coverage_start: d(-30), coverage_end: d(300) });
  check('pending verification for T.K. (sweep target)', r.status === 201);

  r = await req('POST', `/api/clinics/${clinicId}/authorizations`, {
    patient_id: tkId, auth_number: 'AUTH-P3', payer: 'Aetna', cpt_codes: '97153', total_units: 8, units_used: 0, start_date: d(-30), end_date: d(9),
  });
  check('authorization AUTH-P3 (9 days left)', r.status === 201);
  const authId = r.json.authorization.id;

  r = await req('POST', `/api/clinics/${clinicId}/claims`, {
    patient_id: tkId, authorization_id: authId, date_of_service: d(-2), cpt_code: '97153', units: 4, billed_amount: 240,
  });
  check('claim created', r.status === 201);
  const claimId = r.json.claim.id;

  r = await req('POST', `/api/clinics/${clinicId}/claims/${claimId}/scrub`, {});
  check('scrub passes with auth-expiry warning (9 days)', r.json.scrub.passed === true && r.json.scrub.errors.some((e) => e.code === 'auth-expiring' && e.severity === 'warning'));

  r = await req('POST', `/api/clinics/${clinicId}/denials`, { claim_id: claimId, denial_code: 'CO-97', reason: 'Included in another payment', appeal_deadline: d(10) });
  check('denial recorded (appeal deadline in 10 days)', r.status === 201);

  // --- subscription lifecycle ------------------------------------------
  r = await req('GET', `/api/clinics/${clinicId}/subscription`);
  check('subscription starts at none, $500/mo, Paddle not connected', r.json.subscription.status === 'none' && r.json.subscription.priceMonthly === 500 && r.json.subscription.paddle.mode === 'not-configured');

  r = await req('POST', `/api/clinics/${clinicId}/subscription/trial`, {});
  check('trial starts, ends in 7 days', r.status === 201 && r.json.subscription.status === 'trial' && r.json.subscription.trialEndsAt === d(7));

  r = await req('POST', `/api/clinics/${clinicId}/subscription/trial`, {});
  check('second trial refused', r.status === 409);

  r = await req('POST', `/api/clinics/${clinicId}/subscription/activate`, {});
  check('activate → active, trial cleared', r.status === 200 && r.json.subscription.status === 'active' && r.json.subscription.trialEndsAt === null);

  r = await req('POST', `/api/clinics/${clinicId}/subscription/pause`, {});
  check('pause → paused', r.status === 200 && r.json.subscription.status === 'paused');

  r = await req('POST', `/api/clinics/${clinicId}/subscription/resume`, {});
  check('resume → active', r.status === 200 && r.json.subscription.status === 'active');

  r = await req('POST', `/api/clinics/${clinicId}/subscription/cancel`, {});
  check('cancel → cancelled', r.status === 200 && r.json.subscription.status === 'cancelled');

  r = await req('POST', `/api/clinics/${clinicId}/subscription/activate`, {});
  check('re-subscribe from cancelled → active', r.status === 200 && r.json.subscription.status === 'active');

  r = await req('GET', `/api/clinics/${clinicId}/audit?limit=500`);
  const subActions = new Set(r.json.audit.filter((a) => a.entity === 'subscription').map((a) => a.action));
  check('audit log records subscription lifecycle', ['trial-start', 'activate', 'pause', 'resume', 'cancel'].every((a) => subActions.has(a)));

  // --- roles on subscription --------------------------------------------
  r = await req('POST', '/api/auth/register', { name: 'Vera Viewer', email: 'viewer@p3.example', password: 'password123', role: 'viewer', clinic_id: clinicId });
  check('viewer account created', r.status === 201);
  r = await req('POST', '/api/auth/login', { email: 'viewer@p3.example', password: 'password123' });
  const viewerCookie = cookie;
  check('viewer login works', r.status === 200);

  r = await req('POST', `/api/clinics/${clinicId}/subscription/trial`, {}, viewerCookie);
  check('viewer cannot change subscription', r.status === 403);

  cookie = ownerCookie; // back to owner (register is owner-only)
  r = await req('POST', '/api/auth/register', { name: 'Ben Biller', email: 'biller@p3.example', password: 'password123', role: 'biller', clinic_id: clinicId });
  check('biller account created', r.status === 201);
  r = await req('POST', '/api/auth/login', { email: 'biller@p3.example', password: 'password123' });
  const billerCookie = cookie;

  r = await req('POST', `/api/clinics/${clinicId}/subscription/cancel`, {}, billerCookie);
  check('biller cannot change subscription', r.status === 403);

  cookie = ownerCookie;

  // --- Paddle webhook -----------------------------------------------------
  const webhookBody = (eventType, status, customData, endsAt) => JSON.stringify({
    event_type: eventType,
    data: {
      id: 'sub_test_123', customer_id: 'ctm_test_123', status,
      custom_data: customData,
      current_billing_period: endsAt ? { ends_at: `${endsAt}T00:00:00Z` } : undefined,
    },
  });
  const paddleSig = (secret, rawBody) => {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
  };

  r = await req('POST', '/api/paddle/webhook', { event_type: 'subscription.updated', data: {} });
  check('webhook without secret → 503 (not configured)', r.status === 503);

  process.env.PADDLE_WEBHOOK_SECRET = 'test-webhook-secret';
  const badBody = webhookBody('subscription.updated', 'trialing', { clinic_id: clinicId }, d(14));
  r = await req('POST', '/api/paddle/webhook', JSON.parse(badBody), undefined, { 'Paddle-Signature': 'ts=1;h1=deadbeef' });
  check('webhook with bad signature → 401', r.status === 401);

  const trialBody = webhookBody('subscription.updated', 'trialing', { clinic_id: clinicId }, d(14));
  r = await req('POST', '/api/paddle/webhook', JSON.parse(trialBody), undefined, { 'Paddle-Signature': paddleSig('test-webhook-secret', trialBody) });
  check('webhook trialing → clinic on trial', r.status === 200 && r.json.handled === true && r.json.status === 'trial');

  r = await req('GET', `/api/clinics/${clinicId}/subscription`);
  check('webhook trial end date recorded', r.json.subscription.status === 'trial' && r.json.subscription.trialEndsAt === d(14) && r.json.subscription.paddleSubscriptionId === 'sub_test_123');

  const cancelBody = webhookBody('subscription.canceled', 'canceled', { clinic_id: clinicId });
  r = await req('POST', '/api/paddle/webhook', JSON.parse(cancelBody), undefined, { 'Paddle-Signature': paddleSig('test-webhook-secret', cancelBody) });
  check('webhook canceled → clinic cancelled', r.status === 200 && r.json.status === 'cancelled');

  const otherBody = webhookBody('transaction.completed', 'completed', { clinic_id: clinicId });
  r = await req('POST', '/api/paddle/webhook', JSON.parse(otherBody), undefined, { 'Paddle-Signature': paddleSig('test-webhook-secret', otherBody) });
  check('non-subscription event acknowledged, ignored', r.status === 200 && r.json.handled === false);

  const noClinicBody = webhookBody('subscription.updated', 'active', {});
  r = await req('POST', '/api/paddle/webhook', JSON.parse(noClinicBody), undefined, { 'Paddle-Signature': paddleSig('test-webhook-secret', noClinicBody) });
  check('webhook without clinic mapping acknowledged, not crashed', r.status === 200 && r.json.handled === false);

  // --- alert digests --------------------------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/alerts/send-digest`, {});
  check('send-digest refused while alerts are off', r.status === 409);

  r = await req('PATCH', `/api/clinics/${clinicId}`, { alerts_enabled: true, alert_email: 'alerts@example.com' });
  check('alerts enabled + alert email set', r.status === 200 && r.json.clinic.alerts_enabled === true);

  r = await req('POST', `/api/clinics/${clinicId}/alerts/send-digest`, {});
  check('digest composed (auth expiry + appeal deadline)', r.status === 200 && r.json.items === 2 && r.json.digest.itemCount === 2);
  check('digest delivery recorded as failed honestly (no Resend key)', r.json.sent === false && r.json.digest.status === 'failed' && /Resend/i.test(r.json.digest.error || ''));
  const digestId = r.json.digest.id;

  r = await req('POST', `/api/clinics/${clinicId}/alerts/send-digest`, {});
  check('second send today returns the same digest (no duplicate)', r.status === 200 && r.json.digest.id === digestId);

  r = await req('GET', `/api/clinics/${clinicId}/alert-digests`);
  check('digest history lists exactly one row', r.json.digests.length === 1 && r.json.digests[0].status === 'failed');

  // --- automation rules + daily sweep -----------------------------------------
  r = await req('GET', '/api/automation/rules');
  check('5 automation rules, all on', r.json.rules.length === 5 && r.json.rules.every((x) => x.enabled === true));

  r = await req('GET', '/api/automation/runs');
  check('run history starts empty', r.json.runs.length === 0);

  r = await req('PATCH', `/api/clinics/${clinicId}`, { payer_calls_opt_in: true });
  check('payer-call opt-in enabled for the sweep', r.status === 200 && r.json.clinic.payer_calls_opt_in === true);

  r = await req('POST', `/api/clinics/${clinicId}/call-queue`, { claim_id: claimId, question: 'Why was this claim denied for CO-97?' });
  check('queue item added for the call runner', r.status === 201);
  const queueId = r.json.queueItem.id;

  r = await req('POST', '/api/automation/run-daily', {});
  check('daily sweep runs all 5 rules', r.status === 200 && Object.values(r.json.sweep.rules).every((x) => x.ran === true));
  check('sweep resolved the pending eligibility (simulation)', r.json.sweep.rules.eligibility_checks.result.resolved === 1);
  check('sweep flagged the expiring auth + near appeal deadline', r.json.sweep.rules.auth_scan.result.expiring === 1 && r.json.sweep.rules.followup_scan.result.denialsNearDeadline === 1);
  check('call runner processed the queued call (simulation)', r.json.sweep.rules.call_runner.result.processed === 1);

  r = await req('GET', `/api/clinics/${clinicId}/verifications`);
  const tkVer = r.json.verifications.find((v) => v.patient_id === tkId);
  check('T.K. verification now eligible with SIM-271 ref', tkVer.status === 'eligible' && /^SIM-271-/.test(tkVer.edi_271_ref || ''));

  r = await req('GET', `/api/clinics/${clinicId}/authorizations`);
  check('AUTH-P3 now marked expiring', r.json.authorizations.find((a) => a.id === authId).status === 'expiring');

  r = await req('GET', `/api/clinics/${clinicId}/alerts`);
  check('alerts still list the expiring auth', r.json.alerts.authExpiries.some((a) => a.auth_number === 'AUTH-P3'));

  r = await req('POST', `/api/clinics/${clinicId}/claims/${claimId}/scrub`, {});
  check('scrub still passes on an expiring auth', r.json.scrub.passed === true);

  r = await req('GET', `/api/clinics/${clinicId}/call-queue`);
  check('queue item done after sweep', r.json.queue.find((q) => q.id === queueId).status === 'done');

  r = await req('GET', `/api/clinics/${clinicId}/payer-calls`);
  check('sweep logged a simulated Sara call (pending)', r.json.calls.length === 1 && r.json.calls[0].caller === 'sara' && r.json.calls[0].outcome === 'pending' && r.json.calls[0].is_simulated === true);

  r = await req('GET', `/api/clinics/${clinicId}/alert-digests`);
  check('sweep did not duplicate today’s digest', r.json.digests.length === 1);

  r = await req('GET', '/api/automation/runs');
  check('run history has all 5 rule runs', r.json.runs.length >= 5);

  r = await req('PATCH', '/api/automation/rules/alert_digest', { enabled: false });
  check('alert_digest rule toggled off', r.status === 200 && r.json.rule.enabled === false);

  r = await req('POST', '/api/automation/run-daily', {});
  check('disabled rule is skipped in the sweep', r.json.sweep.rules.alert_digest.ran === false && r.json.sweep.rules.alert_digest.skipped === true);
  check('already-resolved eligibility stays resolved (0 new)', r.json.sweep.rules.eligibility_checks.result.resolved === 0);

  r = await req('PATCH', '/api/automation/rules/alert_digest', { enabled: true });
  check('alert_digest rule toggled back on', r.status === 200 && r.json.rule.enabled === true);

  r = await req('GET', '/api/automation/rules', undefined, viewerCookie);
  check('viewer cannot list automation rules', r.status === 403);

  r = await req('PATCH', '/api/automation/rules/auth_scan', { enabled: false }, billerCookie);
  check('biller cannot toggle automation rules', r.status === 403);

  // --- internal cron endpoint ---------------------------------------------------
  delete process.env.CRON_SECRET;
  r = await req('POST', '/api/internal/run-daily', {});
  check('internal sweep without CRON_SECRET → 503', r.status === 503);

  process.env.CRON_SECRET = 'test-cron-secret';
  r = await req('POST', '/api/internal/run-daily', {}, undefined, { 'x-cron-secret': 'wrong-secret' });
  check('internal sweep with wrong secret → 401', r.status === 401);

  r = await req('POST', '/api/internal/run-daily', {}, undefined, { 'x-cron-secret': 'test-cron-secret' });
  check('internal sweep with correct secret runs', r.status === 200 && r.json.ok === true && r.json.sweep.rules.auth_scan.ran === true);

  // --- Costs & Model --------------------------------------------------------------
  r = await req('GET', '/api/zenvy/costs');
  check('Zenvy owner sees Costs & Model ($500/mo)', r.status === 200 && r.json.costs.priceMonthly === 500 && Array.isArray(r.json.costs.profit));

  r = await req('POST', '/api/auth/register', { name: 'Clara Clinic Owner', email: 'clinicowner@p3.example', password: 'password123', role: 'owner', clinic_id: clinicId });
  check('clinic-scoped owner account created', r.status === 201);
  r = await req('POST', '/api/auth/login', { email: 'clinicowner@p3.example', password: 'password123' });
  const clinicOwnerCookie = cookie;

  r = await req('GET', '/api/zenvy/costs', undefined, clinicOwnerCookie);
  check('clinic owner CANNOT see Costs & Model', r.status === 403);

  r = await req('GET', '/api/zenvy/costs', undefined, viewerCookie);
  check('viewer CANNOT see Costs & Model', r.status === 403);

  r = await req('GET', `/api/clinics/${clinicId}/subscription`, undefined, clinicOwnerCookie);
  check('clinic owner CAN see their own subscription', r.status === 200 && r.json.subscription.status === 'cancelled');

  // --- UI static check ---------------------------------------------------------------
  const homeRes = await fetch(`${base}/`);
  check('app UI serves', homeRes.status === 200);
  const appJs = await (await fetch(`${base}/app.js`)).text();
  check('UI has Subscribe / Automation / Costs tabs + actions', ['renderSubscribe', 'renderAutomation', 'renderCosts', 'sub-trial', 'run-daily', 'send-digest', 'goto-subscribe'].every((s) => appJs.includes(s)));

  server.close();
  await memPool.end();
  console.log(`\n[test] PASS — ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
