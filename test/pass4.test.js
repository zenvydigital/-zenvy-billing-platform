'use strict';

/**
 * Pass 4 end-to-end verification test — integrations, denial-risk score,
 * auto-appeal drafts, Sara dialer bridge, clinic portal, audit-log
 * hardening. Runs the full API against an in-memory Postgres (pg-mem)
 * + the real Express app over HTTP, on DEMO data, mirroring the
 * artifact's verified end-to-end pass. No live DB, no network, no real
 * keys, no real data. Test data is cleaned up at the end (demo removed).
 *
 * Run with: npm run test:pass4
 */

process.env.JWT_SECRET = 'test-secret-for-pass4-only';
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
  console.log('[test] migrations applied to in-memory DB (005 trigger skipped in pg-mem by design)');

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
  async function reqText(method, path, useCookie) {
    const headers = {};
    const c = useCookie !== undefined ? useCookie : cookie;
    if (c) headers.Cookie = c;
    const r = await fetch(base + path, { method, headers });
    return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') };
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

  // Test clinic (for the portal + dialer denied-branch tests).
  r = await req('POST', '/api/clinics', { name: 'Test Clinic P4', city: 'Columbus', state: 'OH' });
  check('test clinic created', r.status === 201);
  const clinicId = r.json.clinic.id;
  r = await req('PATCH', `/api/clinics/${clinicId}`, { baa_signed: true, payer_calls_opt_in: true, alerts_enabled: true, alert_email: 'alerts@example.com' });
  check('test clinic: BAA + opt-in + alerts on', r.status === 200 && r.json.clinic.baa_signed === true && r.json.clinic.payer_calls_opt_in === true);

  // Clinic-owner user for the portal test.
  r = await req('POST', '/api/auth/register', { name: 'Clinic Owner', email: 'clinicowner@example.com', password: 'password123', clinic_id: clinicId, role: 'owner' });
  check('clinic owner user created', r.status === 201);
  r = await req('POST', '/api/auth/login', { email: 'clinicowner@example.com', password: 'password123' });
  check('clinic owner login works', r.status === 200 && !!cookie);
  const portalCookie = cookie;
  // Back to the Zenvy owner for the build-up.
  r = await req('POST', '/api/auth/login', { email: 'owner@zenvydigitals.online', password: 'password123' }, ownerCookie);
  check('back to Zenvy owner', r.status === 200);
  cookie = ownerCookie;

  // --- demo data ------------------------------------------------------
  r = await req('POST', '/api/demo/load', {});
  check('demo data loaded', r.status === 201);
  const demoId = r.json.demo.clinicId;
  r = await req('PATCH', `/api/clinics/${demoId}`, { payer_calls_opt_in: true });
  check('demo clinic opted in to payer calls', r.status === 200 && r.json.clinic.payer_calls_opt_in === true);

  r = await req('GET', `/api/clinics/${demoId}/claims`);
  const demoClaims = r.json.claims;
  const cleanClaim = demoClaims.find((c) => c.billed_amount === 240 && c.units === 4 && c.status === 'draft');
  const problemClaim = demoClaims.find((c) => c.billed_amount === 480 && c.units === 8);
  const deniedClaim = demoClaims.find((c) => c.status === 'denied');
  check('demo claims found (clean / problem / denied)', !!cleanClaim && !!problemClaim && !!deniedClaim);

  // --- 1. denial-risk score -------------------------------------------
  r = await req('POST', `/api/clinics/${demoId}/claims/${cleanClaim.id}/risk`, {});
  check('risk: clean claim LOW (auth expiring in 9 days, +5)',
    r.status === 200 && r.json.risk.band === 'low' && r.json.risk.score === 5
    && r.json.risk.factors.some((f) => f.code === 'auth-expiring' && f.points === 5));
  const cleanScore = r.json.risk.score;

  r = await req('POST', `/api/clinics/${demoId}/claims/${problemClaim.id}/risk`, {});
  check('risk: problem claim HIGH 50 (eligibility pending +15, auth units +35)',
    r.status === 200 && r.json.risk.band === 'high' && r.json.risk.score === 50
    && r.json.risk.factors.some((f) => f.code === 'eligibility-pending' && f.points === 15)
    && r.json.risk.factors.some((f) => f.code === 'auth-units' && f.points === 35));
  check('risk scores stored on the claims',
    r.json.claim.risk_score === 50 && Array.isArray(r.json.claim.risk_factors));

  // --- 2. scrub → submit (clean claim) ---------------------------------
  r = await req('POST', `/api/clinics/${demoId}/claims/${cleanClaim.id}/scrub`, {});
  check('scrub passes on the clean claim', r.json.scrub.passed === true);
  r = await req('POST', `/api/clinics/${demoId}/claims/${cleanClaim.id}/submit`, {});
  check('clearinghouse submit accepted with batch ref + payer claim # (SIM)',
    r.status === 200 && r.json.claim.status === 'submitted'
    && /^SIM-BATCH-/.test(r.json.claim.clearinghouse_batch_ref)
    && /^SIM-/.test(r.json.claim.payer_claim_number) && r.json.simulation === true);
  const payerNumber = r.json.claim.payer_claim_number;
  const batchRef = r.json.claim.clearinghouse_batch_ref;

  // --- 3. ERA import: one matched as paid, one unmatched ---------------
  r = await req('POST', `/api/clinics/${demoId}/era/import`, {
    rows: [
      { payer_claim_number: payerNumber, paid_amount: 240 },
      { payer_claim_number: 'UNKNOWN-999', patient_initials: 'Z.Z.', date_of_service: d(-5), cpt_code: '97153', paid_amount: 100 },
    ],
  });
  check('ERA import: 1 matched, 1 unmatched (stored honestly)',
    r.status === 201 && r.json.summary.total === 2 && r.json.summary.matched === 1 && r.json.summary.unmatched === 1);
  const matchedLine = r.json.imported.find((l) => l.status === 'matched');
  const unmatchedLine = r.json.imported.find((l) => l.status === 'unmatched');
  check('ERA lines identified', !!matchedLine && !!unmatchedLine);
  r = await req('POST', `/api/clinics/${demoId}/era/${matchedLine.id}/post`, {});
  check('ERA post pays the claim in full', r.status === 200 && r.json.claimStatus === 'paid' && r.json.claimPaid === 240);
  r = await req('GET', `/api/clinics/${demoId}/claims/${cleanClaim.id}`);
  check('claim is now paid', r.json.claim.status === 'paid' && Number(r.json.claim.paid_amount) === 240);

  // --- 4. EDI 276/277 status check --------------------------------------
  r = await req('POST', `/api/clinics/${demoId}/claims/${cleanClaim.id}/status-check`, {});
  check('EDI 276/277 check returns the paid claim in full',
    r.status === 200 && r.json.answer.status === 'paid' && r.json.answer.paidAmount === 240
    && /^EDI-277-SIM-/.test(r.json.edi277Ref) && /^EDI-276-SIM-/.test(r.json.edi276Ref)
    && r.json.simulation === true);
  r = await req('GET', `/api/clinics/${demoId}/claims/${cleanClaim.id}`);
  check('276/277 refs stored on the claim', !!r.json.claim.edi_276_ref && !!r.json.claim.edi_277_ref);
  r = await req('GET', `/api/clinics/${demoId}/edi/batches`);
  check('837 batch listed with the submitted claim',
    r.status === 200 && r.json.batches.length === 1 && r.json.batches[0].batchRef === batchRef
    && r.json.batches[0].claimCount === 1 && r.json.batches[0].totalBilled === 240);

  // --- 5. Sara queue + daily sweep --------------------------------------
  r = await req('GET', `/api/clinics/${demoId}/denials`);
  const demoDenial = r.json.denials.find((x) => x.denial_code === 'CO-97');
  check('demo denial CO-97 found', !!demoDenial);
  r = await req('POST', `/api/clinics/${demoId}/call-queue`, { claim_id: deniedClaim.id, question: 'Why was this claim denied for CO-97, and what is needed to appeal it?' });
  check('Sara call queued for the denied claim', r.status === 201);
  const queuedCallId = r.json.queueItem.id;

  r = await req('POST', '/api/automation/run-daily', {});
  check('daily sweep ran (eligibility + auth + followup + calls + digest)',
    r.status === 200 && Object.values(r.json.sweep.rules).filter((x) => x.ran).length === 5);
  check('sweep: Sara call runner processed 1 queued call',
    r.json.sweep.rules.call_runner.ran === true && r.json.sweep.rules.call_runner.result.processed === 1
    && r.json.sweep.rules.call_runner.result.claimId === deniedClaim.id);
  check('sweep: automated checks resolved T.K. eligibility to ELIGIBLE',
    r.json.sweep.rules.eligibility_checks.result.resolved === 1);
  check('sweep: auth scan raised expiring-auth alerts',
    r.json.sweep.rules.auth_scan.result.expiring >= 1);

  r = await req('GET', `/api/clinics/${demoId}/verifications`);
  const tkVer = r.json.verifications.find((v) => v.payer === 'Aetna');
  check('T.K. verification now eligible with SIM-271 ref',
    tkVer && tkVer.status === 'eligible' && /^SIM-271-/.test(tkVer.edi_271_ref || ''));
  r = await req('GET', `/api/clinics/${demoId}/alerts`);
  check('alerts list the expiring auth + the open appeal deadline',
    r.json.alerts.authExpiries.some((a) => a.auth_number === 'AUTH-DEMO-1')
    && r.json.alerts.appealDeadlines.some((x) => x.claim_id === deniedClaim.id));

  // --- 6. auto-appeal draft ----------------------------------------------
  r = await req('POST', `/api/clinics/${demoId}/denials/${demoDenial.id}/appeal-draft`, {});
  check('appeal draft generated (generic template — demo denial is UHC, not Aetna)',
    r.status === 201 && r.json.template === 'generic'
    && r.json.draft.draft_text.includes('CO-97') && r.json.draft.draft_text.includes(`Claim #${deniedClaim.id}`));
  const draftId = r.json.draft.id;
  r = await req('PATCH', `/api/clinics/${demoId}/appeal-drafts/${draftId}`, { draft_text: `${r.json.draft.draft_text}\n\nEdited by the biller: session note attached.`, status: 'ready' });
  check('appeal draft edited + marked ready', r.status === 200 && r.json.draft.status === 'ready' && r.json.draft.draft_text.includes('Edited by the biller'));
  const dl = await reqText('GET', `/api/clinics/${demoId}/appeal-drafts/${draftId}/download`, ownerCookie);
  check('appeal draft downloads as text with Aetna + CO-97',
    dl.status === 200 && dl.text.includes('CO-97'));
  r = await req('POST', `/api/clinics/${demoId}/appeal-drafts/${draftId}/file`, {});
  check('appeal filed → denial becomes appealing',
    r.status === 200 && r.json.draft.status === 'filed' && r.json.denialStatus === 'appealing');

  // Aetna CO-97 template: an Aetna denial in the test clinic.
  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'A.A.', payer: 'Aetna', member_id: 'M-1' });
  const aaId = r.json.patient.id;
  r = await req('POST', `/api/clinics/${clinicId}/verifications`, { patient_id: aaId, payer: 'Aetna', status: 'eligible' });
  r = await req('POST', `/api/clinics/${clinicId}/authorizations`, {
    patient_id: aaId, auth_number: 'AUTH-P4-A', payer: 'Aetna', cpt_codes: '97153', total_units: 8, units_used: 0, start_date: d(-30), end_date: d(60),
  });
  const authA = r.json.authorization.id;
  r = await req('POST', `/api/clinics/${clinicId}/claims`, {
    patient_id: aaId, authorization_id: authA, date_of_service: d(-2), cpt_code: '97153', units: 2, billed_amount: 100,
  });
  const aetnaClaimId = r.json.claim.id;
  r = await req('POST', `/api/clinics/${clinicId}/denials`, {
    claim_id: aetnaClaimId, denial_code: 'CO-97', reason: 'The benefit for this service is included in the payment for another service already adjudicated.',
  });
  check('Aetna CO-97 denial recorded', r.status === 201);
  const aetnaDenialId = r.json.denial.id;
  r = await req('POST', `/api/clinics/${clinicId}/denials/${aetnaDenialId}/appeal-draft`, {});
  check('Aetna CO-97 template used for an Aetna denial',
    r.status === 201 && r.json.template === 'aetna-co97'
    && r.json.draft.draft_text.includes('Aetna') && r.json.draft.draft_text.includes('CO-97'));

  // --- 7. Sara dialer bridge ----------------------------------------------
  r = await req('POST', `/api/clinics/${demoId}/call-queue`, { claim_id: problemClaim.id, question: 'What is the status of this claim, and is the authorization short on units?' });
  check('second Sara call queued (problem claim)', r.status === 201);
  const problemQueueId = r.json.queueItem.id;

  const csv = await reqText('GET', `/api/clinics/${demoId}/call-queue/export`);
  check('queue exports to CSV (headers + queued claim + question)',
    csv.status === 200 && csv.contentType && csv.contentType.includes('text/csv')
    && csv.text.includes('queue_id,claim_id,patient_initials')
    && csv.text.includes(String(problemClaim.id))
    && csv.text.includes('authorization short on units'));

  // Fresh claim in the test clinic for the denied-import branch.
  r = await req('POST', `/api/clinics/${clinicId}/patients`, { initials: 'P.Q.', payer: 'UHC', member_id: 'M-9' });
  const pqId = r.json.patient.id;
  r = await req('POST', `/api/clinics/${clinicId}/verifications`, { patient_id: pqId, payer: 'UHC', status: 'eligible' });
  r = await req('POST', `/api/clinics/${clinicId}/authorizations`, {
    patient_id: pqId, auth_number: 'AUTH-P4', payer: 'UHC', cpt_codes: '97153', total_units: 8, units_used: 0, start_date: d(-30), end_date: d(60),
  });
  const authP4 = r.json.authorization.id;
  r = await req('POST', `/api/clinics/${clinicId}/claims`, {
    patient_id: pqId, authorization_id: authP4, date_of_service: d(-2), cpt_code: '97153', units: 4, billed_amount: 200,
  });
  const freshClaimId = r.json.claim.id;
  r = await req('POST', `/api/clinics/${clinicId}/claims/${freshClaimId}/submit`, {});
  check('fresh claim submitted (import test setup)', r.status === 200 && r.json.claim.status === 'submitted');
  r = await req('POST', `/api/clinics/${clinicId}/call-queue`, { claim_id: freshClaimId, question: 'Why is this claim still unpaid after 30 days?' });
  const freshQueueId = r.json.queueItem.id;

  r = await req('POST', `/api/clinics/${demoId}/call-queue/import-results`, {
    results: [
      { queue_id: problemQueueId, outcome: 'paid', status_answer: 'Paid in full per payer rep', reference_number: 'REF-P4-1', amount_paid: 480 },
    ],
  });
  check('importCallResults: paid outcome → problem claim paid in full',
    r.status === 200 && r.json.summary.processed === 1 && r.json.summary.failed === 0
    && r.json.processed[0].claimStatus === 'paid');
  r = await req('GET', `/api/clinics/${demoId}/claims/${problemClaim.id}`);
  check('problem claim paid_amount is 480', Number(r.json.claim.paid_amount) === 480);

  r = await req('POST', `/api/clinics/${clinicId}/call-queue/import-results`, {
    results: [
      { queue_id: freshQueueId, outcome: 'denied', status_answer: 'CO-197: authorization not on file', denial_code: 'CO-197' },
      { claim_id: 999999, outcome: 'paid' },
    ],
  });
  check('importCallResults: denied outcome + one bad row reported, not fatal',
    r.status === 200 && r.json.summary.processed === 1 && r.json.summary.failed === 1
    && r.json.failed[0].error.includes('999999'));
  r = await req('GET', `/api/clinics/${clinicId}/claims/${freshClaimId}`);
  check('fresh claim denied by import', r.json.claim.status === 'denied');
  r = await req('GET', `/api/clinics/${clinicId}/denials`);
  check('denial recorded by import (CO-197, open)',
    r.json.denials.some((x) => x.claim_id === freshClaimId && x.denial_code === 'CO-197' && x.status === 'open'));
  r = await req('GET', `/api/clinics/${demoId}/call-queue`);
  check('imported queue items are done', r.json.queue.every((q) => q.status !== 'queued' || q.claim_id !== problemClaim.id));

  // --- 8. integrations: live refused ---------------------------------------
  r = await req('GET', '/api/integrations');
  check('integrations page: 7 vendors, each with steps, all simulation',
    r.status === 200 && r.json.integrations.length === 7
    && r.json.integrations.every((v) => Array.isArray(v.steps) && v.steps.length > 0 && v.mode === 'simulation')
    && r.json.simulation === true);
  r = await req('POST', '/api/integrations/availity/mode', { mode: 'live' });
  check('setConnectionMode to live REFUSED honestly',
    r.status === 409 && /cannot be switched to Live/.test(r.json.error || ''));
  r = await req('GET', '/api/integrations');
  check('Availity still in simulation after the refusal',
    r.json.integrations.find((v) => v.vendor === 'availity').mode === 'simulation');
  r = await req('POST', '/api/integrations/waystar/mode', { mode: 'off' });
  check('mode off is allowed', r.status === 200 && r.json.mode === 'off');
  r = await req('POST', '/api/integrations/waystar/mode', { mode: 'simulation' });
  check('mode simulation is allowed', r.status === 200 && r.json.mode === 'simulation');
  r = await req('POST', '/api/integrations/twilio/mode', { mode: 'live' }, portalCookie);
  check('clinic owner cannot change vendor modes (403)', r.status === 403);

  // --- 9. clinic portal ------------------------------------------------------
  r = await req('GET', '/api/portal', undefined, portalCookie);
  check('portal: clinic owner sees their own clinic only',
    r.status === 200 && r.json.portal.clinic.id === clinicId
    && r.json.portal.claims.every((c) => !demoClaims.some((dc) => dc.id === c.id))
    && r.json.portal.subscription.priceMonthly === 500);
  check('portal: dashboard + AR + alerts present',
    r.json.portal.dashboard && Array.isArray(r.json.portal.ar) && r.json.portal.alerts
    && r.json.portal.dashboard.openArClaims >= 1);
  r = await req('GET', '/api/portal', undefined, ownerCookie);
  check('portal: Zenvy owner gets 403 (portal is for clinic owners)', r.status === 403);

  // --- 10. audit-log hardening -------------------------------------------------
  const mig005 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '005_pass4.sql'), 'utf8');
  check('audit trigger DDL exists (function + trigger on audit_log)',
    mig005.includes('CREATE TRIGGER') && mig005.includes('audit_log')
    && mig005.includes('RAISE EXCEPTION') && mig005.includes('REAL-POSTGRES-ONLY'));
  r = await req('DELETE', `/api/clinics/${clinicId}/audit`, undefined, ownerCookie);
  check('no audit delete endpoint (404)', r.status === 404);
  r = await req('GET', `/api/clinics/${demoId}/audit`, undefined, ownerCookie);
  check('audit log still readable (append-only, read-only API)',
    r.status === 200 && Array.isArray(r.json.audit) && r.json.audit.length > 0
    && r.json.audit.some((a) => a.entity === 'appeal_draft' && a.action === 'file')
    && r.json.audit.some((a) => a.entity === 'appeal_draft' && a.action === 'update'));

  // --- 11. UI serves with the new tabs ------------------------------------------
  r = await req('GET', '/');
  check('UI serves', r.status === 200);
  const appJs = await reqText('GET', '/app.js');
  check('UI has Integrations / Appeals / Portal tabs + new actions',
    appJs.status === 200
    && appJs.text.includes("['integrations', 'Integrations']")
    && appJs.text.includes("['appeals', 'Appeals']")
    && appJs.text.includes("['portal', 'Clinic Portal']")
    && appJs.text.includes('renderIntegrations') && appJs.text.includes('renderAppeals')
    && appJs.text.includes('renderPortal') && appJs.text.includes("action === 'score-claim'")
    && appJs.text.includes("action === 'conn-mode'") && appJs.text.includes("action === 'appeal-file'")
    && appJs.text.includes("kind === 'import-calls'") && appJs.text.includes("kind === 'edi-status-check'"));

  // --- 12. cleanup ---------------------------------------------------------------
  r = await req('POST', '/api/demo/remove', {}, ownerCookie);
  check('demo data removed', r.status === 200 && r.json.removed === 1);
  r = await req('GET', '/api/clinics', undefined, ownerCookie);
  check('demo clinic gone from the clinic list', !r.json.clinics.some((c) => c.is_demo));
  r = await req('GET', `/api/clinics/${demoId}/claims`, undefined, ownerCookie);
  check('demo clinic data no longer reachable', r.status === 404);

  server.close();
  await memPool.end();
  console.log(`\n[test] PASS — ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('[test] FAILED:', err.message);
  process.exit(1);
});
