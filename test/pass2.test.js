'use strict';

/**
 * Pass 2 verification test — runs the full core API against an in-memory
 * Postgres (pg-mem) + the real Express app over HTTP. No live DB, no
 * network, no real data.
 *
 * Covers: auth + roles, BAA gate, initials validation, viewer block,
 * referrals → patient, verifications + authorizations + expiry scan,
 * sessions → draft claim, scrubber pass/fail, submit gate, partial-update
 * merge, linked deletes, denials, payer-call opt-in gate + outcome
 * updates claim, ERA import/match/post, AR + dashboard, CSV preview/
 * import/export, demo load/remove, audit log.
 *
 * Run with: npm run test:pass2
 */

process.env.JWT_SECRET = 'test-secret-for-pass2-only';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
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
  async function req(method, path, body, useCookie) {
    const headers = { 'Content-Type': 'application/json' };
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
    try { json = await r.json(); } catch { /* non-JSON (CSV) */ }
    return { status: r.status, json, raw: r };
  }
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // --- health + bootstrap -------------------------------------------
  let r = await req('GET', '/health');
  check('health answers, db up', r.status === 200 && r.json.ok && r.json.db === 'up');

  r = await req('GET', '/api/auth/status');
  check('no users yet (bootstrap mode)', r.json.usersExist === false);

  r = await req('POST', '/api/auth/register', { name: 'Zenvy Owner', email: 'owner@zenvydigitals.online', password: 'password123' });
  check('bootstrap owner created', r.status === 201 && r.json.user.role === 'owner');
  check('bootstrap register sets a session cookie', !!cookie);

  r = await req('GET', '/api/auth/me');
  check('me works right after bootstrap register (no separate login)', r.status === 200 && r.json.user.email === 'owner@zenvydigitals.online');

  r = await req('POST', '/api/auth/login', { email: 'owner@zenvydigitals.online', password: 'password123' });
  check('owner login works', r.status === 200 && !!cookie);
  const ownerCookie = cookie;

  r = await req('GET', '/api/auth/me');
  check('me returns owner', r.json.user.email === 'owner@zenvydigitals.online');

  // --- clinics + BAA gate -------------------------------------------
  r = await req('POST', '/api/clinics', { name: 'Test Clinic A', city: 'Columbus', state: 'OH' });
  check('clinic created', r.status === 201 && r.json.clinic.name === 'Test Clinic A');
  const clinicId = r.json.clinic.id;

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'T.K.', payer: 'Aetna', member_id: 'M-1' });
  check('BAA gate rejects real patient without BAA', r.status === 403 && /BAA/.test(r.json.error));

  r = await req('POST', `/api/clinics/${clinicId}/referrals`, { referral_initials: 'N.P.', source: 'Website' });
  check('BAA gate rejects referral without BAA', r.status === 403);

  r = await req('PATCH', `/api/clinics/${clinicId}`, { baa_signed: true });
  check('BAA recorded (owner-only flag)', r.status === 200 && r.json.clinic.baa_signed === true);

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'John Smith', payer: 'Aetna' });
  check('full name rejected (initials only)', r.status === 400 && /initials only/i.test(r.json.error));

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'T.K.', payer: 'Aetna', member_id: 'M-1' });
  check('patient T.K. created', r.status === 201);
  const tkId = r.json.patient.id;

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'L.M.', payer: 'BCBS', member_id: 'M-2' });
  check('patient L.M. created', r.status === 201);
  const lmId = r.json.patient.id;

  // --- viewer role ---------------------------------------------------
  r = await req('POST', '/api/auth/register', { name: 'Vera Viewer', email: 'viewer@testclinic.example', password: 'password123', role: 'viewer', clinic_id: clinicId });
  check('viewer account created by owner', r.status === 201 && r.json.user.role === 'viewer');
  check('non-bootstrap register keeps the owner signed in', cookie === ownerCookie);

  r = await req('POST', '/api/auth/login', { email: 'viewer@testclinic.example', password: 'password123' });
  const viewerCookie = cookie;
  check('viewer login works', r.status === 200);

  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'X.Y.' });
  check('viewer write blocked', r.status === 403 && /read-only/i.test(r.json.error));

  r = await req('GET', `/api/clinics/${clinicId}/claims`, undefined, viewerCookie);
  check('viewer can read', r.status === 200 && Array.isArray(r.json.claims));

  cookie = ownerCookie; // back to owner

  // --- referrals → patient -------------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/referrals`, { referral_initials: 'N.P.', source: 'Website' });
  check('referral created', r.status === 201);
  const refId = r.json.referral.id;

  r = await req('POST', `/api/clinics/${clinicId}/referrals/${refId}/convert`, { payer: 'UHC', member_id: 'M-3' });
  check('referral converted to patient', r.status === 200 && r.json.patient.initials === 'N.P.' && r.json.referral.status === 'converted');
  const npId = r.json.patient.id;

  // --- verifications + authorizations ---------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/verifications`, { patient_id: tkId, payer: 'Aetna', status: 'eligible' });
  check('verification eligible', r.status === 201);

  r = await req('POST', `/api/clinics/${clinicId}/verifications`, { patient_id: lmId, payer: 'BCBS', status: 'eligible' });
  check('verification eligible for L.M.', r.status === 201);

  r = await req('POST', `/api/clinics/${clinicId}/authorizations`, {
    patient_id: tkId, auth_number: 'AUTH-1', payer: 'Aetna', cpt_codes: '97153', total_units: 8, units_used: 0, start_date: d(-30), end_date: d(9),
  });
  check('authorization AUTH-1 created', r.status === 201);
  const auth1Id = r.json.authorization.id;

  r = await req('POST', `/api/clinics/${clinicId}/authorizations`, {
    patient_id: lmId, auth_number: 'AUTH-2', payer: 'BCBS', cpt_codes: '97153,97155', total_units: 40, units_used: 0, start_date: d(-30), end_date: d(60),
  });
  check('authorization AUTH-2 created', r.status === 201);

  r = await req('GET', `/api/clinics/${clinicId}/authorizations`);
  const auth1 = r.json.authorizations.find((a) => a.auth_number === 'AUTH-1');
  check('expiry scan: AUTH-1 has 9 days left, 8 units', auth1.days_left === 9 && auth1.units_remaining === 8);

  r = await req('GET', `/api/clinics/${clinicId}/alerts`);
  check('alerts list AUTH-1 expiry', r.json.alerts.authExpiries.some((a) => a.auth_number === 'AUTH-1'));

  // --- sessions → draft claim -----------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/sessions`, {
    patient_id: tkId, authorization_id: auth1Id, session_date: d(-1), cpt_code: '97153', units: 8, duration_min: 120, status: 'completed',
  });
  check('completed session created', r.status === 201);
  const sessionId = r.json.session.id;

  r = await req('POST', `/api/clinics/${clinicId}/sessions/${sessionId}/create-claim`, {});
  check('session → draft claim', r.status === 201 && r.json.claim.status === 'draft');
  const claimId = r.json.claim.id;

  // --- scrubber: fail, then pass, then submit -------------------------
  r = await req('POST', `/api/clinics/${clinicId}/claims`, {
    patient_id: tkId, authorization_id: auth1Id, date_of_service: d(-2), cpt_code: '97153', units: 10, billed_amount: 600,
  });
  check('problem claim created (10 units)', r.status === 201);
  const badClaimId = r.json.claim.id;

  r = await req('POST', `/api/clinics/${clinicId}/claims/${badClaimId}/scrub`, {});
  check('scrub FAILS problem claim (auth units)', r.json.scrub.passed === false && r.json.scrub.errors.some((e) => e.code === 'auth-units'));

  r = await req('POST', `/api/clinics/${clinicId}/claims/${badClaimId}/submit`, {});
  check('submit gate blocks failed scrub', r.status === 409 && /scrub/i.test(r.json.error));

  r = await req('PATCH', `/api/clinics/${clinicId}/claims/${badClaimId}`, { units: 8 });
  check('claim units fixed to 8', r.status === 200 && r.json.claim.units === 8);

  r = await req('POST', `/api/clinics/${clinicId}/claims/${badClaimId}/scrub`, {});
  check('scrub PASSES after fix', r.json.scrub.passed === true && r.json.claim.status === 'ready');

  // Partial-update merge: notes-only patch must not blank CPT / DOS.
  r = await req('PATCH', `/api/clinics/${clinicId}/claims/${badClaimId}`, { notes: 'billed after auth check' });
  check('partial update merges (CPT + DOS kept)', r.json.claim.cpt_code === '97153' && r.json.claim.date_of_service === d(-2) && r.json.claim.notes === 'billed after auth check');

  r = await req('POST', `/api/clinics/${clinicId}/claims/${badClaimId}/submit`, {});
  check('submit accepted (simulation batch + payer number)', r.status === 200 && r.json.claim.status === 'submitted' && /^SIM-BATCH-/.test(r.json.claim.clearinghouse_batch_ref) && /^SIM-/.test(r.json.claim.payer_claim_number) && r.json.simulation === true);
  const submittedPayerNo = r.json.claim.payer_claim_number;

  // --- denials + payer calls (opt-in gate) -----------------------------
  r = await req('POST', `/api/clinics/${clinicId}/denials`, { claim_id: badClaimId, denial_code: 'CO-197', reason: 'Authorization missing', appeal_deadline: d(20) });
  check('denial recorded, claim denied', r.status === 201 && r.json.denial.denial_code === 'CO-197');

  r = await req('POST', `/api/clinics/${clinicId}/call-queue`, { claim_id: badClaimId, question: 'Why was claim SIM denied for CO-197?' });
  check('payer-call queue refused without opt-in', r.status === 403 && /opt-in/i.test(r.json.error));

  r = await req('PATCH', `/api/clinics/${clinicId}`, { payer_calls_opt_in: true });
  check('payer-call opt-in enabled', r.status === 200 && r.json.clinic.payer_calls_opt_in === true);

  r = await req('POST', `/api/clinics/${clinicId}/call-queue`, { claim_id: badClaimId, question: 'Why was this claim denied for CO-197?' });
  check('queue item added after opt-in', r.status === 201);
  const queueId = r.json.queueItem.id;

  r = await req('POST', `/api/clinics/${clinicId}/payer-calls`, {
    claim_id: badClaimId, queue_id: queueId, caller: 'team', outcome: 'paid',
    status_answer: 'Payer confirmed payment in full', reference_number: 'REF-1', next_action: 'Watch ERA',
  });
  check('call outcome paid → claim paid', r.status === 201 && r.json.claim.status === 'paid' && r.json.simulation === true);

  r = await req('GET', `/api/clinics/${clinicId}/denials`);
  check('denial auto-resolved by paid call', r.json.denials.every((x) => x.status !== 'open'));

  // --- ERA import / match / post ---------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/claims`, {
    patient_id: lmId, authorization_id: null, date_of_service: d(-5), cpt_code: '97153', units: 4, billed_amount: 240,
  });
  const eraClaimId = r.json.claim.id;
  await req('POST', `/api/clinics/${clinicId}/claims/${eraClaimId}/scrub`, {});
  // Give it an auth so scrub passes: link AUTH-2 then re-scrub.
  await req('PATCH', `/api/clinics/${clinicId}/claims/${eraClaimId}`, { authorization_id: (await req('GET', `/api/clinics/${clinicId}/authorizations`)).json.authorizations.find((a) => a.auth_number === 'AUTH-2').id });
  r = await req('POST', `/api/clinics/${clinicId}/claims/${eraClaimId}/submit`, {});
  check('second claim submitted for ERA test', r.status === 200);
  const eraPayerNo = r.json.claim.payer_claim_number;

  r = await req('POST', `/api/clinics/${clinicId}/era/import`, { rows: [
    { payer_claim_number: eraPayerNo, patient_initials: 'L.M.', date_of_service: d(-5), cpt_code: '97153', paid_amount: 240, raw_ref: 'ERA-TEST-1' },
    { payer_claim_number: 'SIM-999999', patient_initials: 'X.Y.', date_of_service: d(-5), cpt_code: '97153', paid_amount: 100, raw_ref: 'ERA-TEST-2' },
  ] });
  check('ERA import: 1 matched, 1 unmatched', r.status === 201 && r.json.summary.matched === 1 && r.json.summary.unmatched === 1);
  const matchedLine = r.json.imported.find((l) => l.status === 'matched');
  const unmatchedLine = r.json.imported.find((l) => l.status === 'unmatched');

  r = await req('POST', `/api/clinics/${clinicId}/era/${matchedLine.id}/post`, {});
  check('ERA post pays claim in full', r.status === 200 && r.json.claimStatus === 'paid');

  r = await req('POST', `/api/clinics/${clinicId}/era/${unmatchedLine.id}/match`, { claim_id: eraClaimId });
  check('manual match works', r.status === 200 && r.json.era.status === 'matched');

  // --- AR + dashboard ---------------------------------------------------
  r = await req('GET', `/api/clinics/${clinicId}/ar`);
  check('AR aging returns buckets', r.status === 200 && r.json.ar.buckets && typeof r.json.ar.buckets['0-30'].count === 'number');

  r = await req('GET', `/api/clinics/${clinicId}/dashboard`);
  check('dashboard recovered-this-month > 0', r.json.dashboard.recoveredThisMonth > 0);

  r = await req('GET', `/api/clinics/${clinicId}/reports/weekly`);
  check('weekly report has totals', r.json.report.totals.totalClaims >= 3 && r.json.report.totals.totalRecovered > 0);

  // --- linked deletes ----------------------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/sessions`, {
    patient_id: lmId, session_date: d(-1), cpt_code: '97153', units: 4, status: 'completed',
  });
  const s2 = r.json.session.id;
  r = await req('POST', `/api/clinics/${clinicId}/sessions/${s2}/create-claim`, {});
  const draftClaimId = r.json.claim.id;
  r = await req('DELETE', `/api/clinics/${clinicId}/claims/${draftClaimId}`);
  check('claim delete unlinks session', r.status === 200);
  r = await req('GET', `/api/clinics/${clinicId}/sessions`);
  check('session unlinked (claim_id null)', r.json.sessions.find((s) => s.id === s2).claim_id === null);

  r = await req('DELETE', `/api/clinics/${clinicId}/claims/${badClaimId}`);
  check('claim with denial/call history cannot be deleted (plain message)', r.status === 409 && !/SQL|violates|foreign key/i.test(r.json.error));

  r = await req('DELETE', `/api/clinics/${clinicId}/patients/${tkId}`);
  check('patient with billing records cannot be deleted (plain message)', r.status === 409 && /billing records/i.test(r.json.error));

  r = await req('DELETE', `/api/clinics/${clinicId}/patients/${npId}`);
  check('patient without records deletes; referral closed', r.status === 200);
  r = await req('GET', `/api/clinics/${clinicId}/referrals`);
  check('converted referral closed after patient delete', r.json.referrals.find((x) => x.id === refId).status === 'closed');

  // --- CSV preview / import / export --------------------------------------
  r = await req('POST', `/api/clinics/${clinicId}/import/patients/preview`, { rows: [
    { initials: 'John Smith', payer: 'BCBS', member_id: 'M-9' },
    { initials: 'S.R.', payer: 'BCBS', member_id: 'M-9' },
    { initials: 'T.K.', payer: 'Aetna', member_id: 'M-1' },
  ] });
  check('CSV preview: 1 ready, 1 needs-fixing, 1 duplicate', r.json.summary.ready === 1 && r.json.summary.needsFixing === 1 && r.json.summary.duplicates === 1);

  r = await req('POST', `/api/clinics/${clinicId}/import/patients`, { rows: [
    { initials: 'John Smith', payer: 'BCBS', member_id: 'M-9' },
    { initials: 'S.R.', payer: 'BCBS', member_id: 'M-9' },
    { initials: 'T.K.', payer: 'Aetna', member_id: 'M-1' },
  ] });
  check('CSV import: 1 inserted, 1 skipped, 1 failed', r.json.inserted === 1 && r.json.skipped === 1 && r.json.failed.length === 1);

  const csvRes = await fetch(`${base}/api/clinics/${clinicId}/export/patients`, { headers: { Cookie: ownerCookie } });
  const csvText = await csvRes.text();
  check('CSV export contains imported patient', csvRes.status === 200 && csvText.includes('S.R.'));

  const tplRes = await fetch(`${base}/api/clinics/${clinicId}/templates/patients`, { headers: { Cookie: ownerCookie } });
  check('CSV template served', tplRes.status === 200 && (await tplRes.text()).startsWith('initials,payer,member_id'));

  // --- demo data ------------------------------------------------------------
  r = await req('POST', '/api/demo/load', {});
  check('demo data loaded', r.status === 201 && r.json.demo.clinicId);
  const demoClinicId = r.json.demo.clinicId;

  r = await req('GET', `/api/clinics/${demoClinicId}/dashboard`);
  check('demo dashboard shows recovered money', r.json.dashboard.recoveredThisMonth === 240);

  r = await req('POST', '/api/demo/load', {});
  check('demo load twice refused', r.status === 409);

  r = await req('POST', '/api/demo/remove', {});
  check('demo data removed', r.status === 200 && r.json.removed === 1);

  r = await req('GET', '/api/clinics');
  check('demo clinic gone from list', !r.json.clinics.some((c) => c.id === demoClinicId));

  // --- audit log -------------------------------------------------------------
  r = await req('GET', `/api/clinics/${clinicId}/audit?limit=500`);
  const actions = new Set(r.json.audit.map((a) => a.action));
  check('audit log records writes (create/update/submit/scrub/login)', ['create', 'update', 'submit', 'scrub', 'login'].every((a) => actions.has(a)));

  // --- clinic delete guard -----------------------------------------------------
  r = await req('DELETE', `/api/clinics/${clinicId}`);
  check('clinic with data cannot be deleted (plain message)', r.status === 409 && /still holds data/i.test(r.json.error));

  server.close();
  await memPool.end();
  console.log(`\n[test] PASS — ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
