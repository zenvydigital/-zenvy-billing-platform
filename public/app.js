'use strict';
/* Zenvy Billing Platform — client app. Talks to the JSON API (cookie session). */

const $ = (s) => document.querySelector(s);
const state = { user: null, clinics: [], clinicId: null, tab: 'dashboard', cache: {} };

const TABS = [
  ['dashboard', 'Dashboard'], ['patients', 'Patients'], ['referrals', 'Referrals'],
  ['verifications', 'Eligibility'], ['authorizations', 'Authorizations'],
  ['sessions', 'Sessions'], ['claims', 'Claims'], ['denials', 'Denials'],
  ['appeals', 'Appeals'], ['calls', 'Payer Calls'], ['era', 'ERA / Payments'], ['ar', 'AR & Reports'],
  ['import', 'Import / Export'], ['audit', 'Audit Log'], ['settings', 'Settings'],
  ['subscribe', 'Subscribe'], ['automation', 'Automation'], ['costs', 'Costs & Model'],
  ['integrations', 'Integrations'], ['portal', 'Clinic Portal'],
];

const CPTS = ['97151', '97152', '97153', '97154', '97155', '97156', '97157', '97158'];

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 4200);
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'Bad response from the server.' }));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
  return j;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});
const patch = (p, b) => api('PATCH', p, b || {});
const del = (p) => api('DELETE', p);

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const pushF = () => { row.push(field); field = ''; };
  const pushR = () => { pushF(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') pushF();
    else if (c === '\n') pushR();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) pushR();
  const clean = rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  if (!clean.length) return [];
  const headers = clean[0].map((h) => String(h).trim());
  return clean.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] !== undefined ? String(r[i]).trim() : ''; });
    return o;
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read that file.'));
    fr.readAsText(file);
  });
}

function pillFor(status) {
  const map = {
    eligible: 'ok', paid: 'ok', passed: 'ok', active: 'ok', matched: 'ok', posted: 'ok',
    pending: 'warn', ready: 'warn', submitted: 'warn', partial: 'warn', appealing: 'warn',
    denied: 'bad', failed: 'bad', ineligible: 'bad', unmatched: 'bad', open: 'bad',
    expired: 'bad', exhausted: 'bad', draft: '', scheduled: '', new: '',
  };
  return `<span class="pill ${map[status] || ''}">${esc(status)}</span>`;
}

function isOwner() { return state.user && state.user.role === 'owner'; }
function isZenvyOwner() { return state.user && state.user.role === 'owner' && state.user.clinic_id === null; }
function canWrite() { return state.user && state.user.role !== 'viewer'; }

// ------------------------------------------------------------------ auth

async function boot() {
  try {
    const s = await get('/api/auth/status');
    if (!s.usersExist) return showSetup();
    try {
      const me = await get('/api/auth/me');
      state.user = me.user;
      return showApp();
    } catch {
      return showLogin();
    }
  } catch (e) {
    $('#authView').innerHTML = `<div class="card"><h2>Server not reachable</h2><p>${esc(e.message)}</p></div>`;
  }
}

function showSetup() {
  $('#authView').innerHTML = `
    <div class="card">
      <span class="pill">First run</span>
      <h2>Create the Zenvy owner account</h2>
      <p>No accounts exist yet. Create the first owner account — this signs you in as the Zenvy platform owner.</p>
      <form class="grid" data-form="setup">
        <label>Your name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Password (8+ characters)<input name="password" type="password" minlength="8" required></label>
        <span></span><span></span><span></span>
        <button class="btn" type="submit">Create owner account</button>
      </form>
    </div>`;
}

function showLogin() {
  $('#authView').innerHTML = `
    <div class="card">
      <h2>Sign in</h2>
      <p>Use the email and password your clinic owner gave you.</p>
      <form class="grid" data-form="login">
        <label>Email<input name="email" type="email" required></label>
        <label>Password<input name="password" type="password" required></label>
        <span></span>
        <button class="btn" type="submit">Sign in</button>
      </form>
    </div>`;
}

async function showApp() {
  $('#authView').innerHTML = '';
  $('#appView').classList.remove('hidden');
  $('#whoBox').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
  $('#clinicPicker').classList.remove('hidden');
  $('#whoBox').innerHTML = `${esc(state.user.name)}<br>${esc(state.user.email)} · ${esc(state.user.role)}`;
  const { clinics } = await get('/api/clinics');
  state.clinics = clinics;
  const sel = $('#clinicSelect');
  sel.innerHTML = clinics.map((c) => `<option value="${c.id}">${esc(c.name)}${c.is_demo ? ' (SAMPLE DATA)' : ''}</option>`).join('');
  state.clinicId = state.user.clinic_id || (clinics[0] && clinics[0].id);
  if (state.clinicId) sel.value = String(state.clinicId);
  sel.onchange = () => { state.clinicId = Number(sel.value); state.cache = {}; renderTab(); };
  renderTabs();
  renderTab();
}

function visibleTabs() {
  return TABS.filter(([k]) => {
    if (k === 'automation' || k === 'costs') return isZenvyOwner();
    if (k === 'subscribe') return isOwner();
    if (k === 'portal') return state.user.clinic_id !== null;
    return true;
  });
}

function renderTabs() {
  $('#tabs').innerHTML = visibleTabs().map(([k, label]) =>
    `<button class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('');
}

async function renderTab() {
  renderTabs();
  const el = $('#tabContent');
  if (!state.clinicId) {
    // Automation and Costs & Model are platform-level (Zenvy owner) and
    // need no clinic selected. Settings still works so the first clinic
    // can be created or the demo data loaded.
    if (['automation', 'costs'].includes(state.tab) && isZenvyOwner()) {
      el.innerHTML = '<div class="card"><p>Loading…</p></div>';
      try {
        const fn = TAB_RENDER[state.tab];
        el.innerHTML = await fn();
      } catch (e) {
        el.innerHTML = `<div class="card"><h2>Could not load this page</h2><p>${esc(e.message)}</p></div>`;
      }
      return;
    }
    if (state.tab === 'settings' && isZenvyOwner()) {
      el.innerHTML = renderNoClinicSettings();
      return;
    }
    el.innerHTML = '<div class="card"><h2>No clinic selected</h2><p>Create a clinic or load the demo data from Settings.</p></div>';
    return;
  }
  el.innerHTML = '<div class="card"><p>Loading…</p></div>';
  try {
    const fn = TAB_RENDER[state.tab] || renderDashboard;
    el.innerHTML = await fn();
  } catch (e) {
    el.innerHTML = `<div class="card"><h2>Could not load this page</h2><p>${esc(e.message)}</p></div>`;
  }
}

function clinic() { return state.clinics.find((c) => c.id === state.clinicId); }
function cid() { return state.clinicId; }

async function loadCache() {
  if (state.cache.patients) return state.cache;
  const [patients, auths, claims] = await Promise.all([
    get(`/api/clinics/${cid()}/patients`),
    get(`/api/clinics/${cid()}/authorizations`),
    get(`/api/clinics/${cid()}/claims`),
  ]);
  state.cache = { patients: patients.patients, auths: auths.authorizations, claims: claims.claims };
  return state.cache;
}

function patientOptions(selected) {
  const list = (state.cache.patients || []);
  return list.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.initials)}${p.payer ? ' · ' + esc(p.payer) : ''}</option>`).join('');
}
function claimOptions(selected) {
  const list = (state.cache.claims || []);
  return list.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>#${c.id} · ${esc(c.cpt_code)} · ${esc(c.date_of_service)} · ${money(c.billed_amount)} · ${esc(c.status)}</option>`).join('');
}

// --------------------------------------------------------------- dashboard

async function renderDashboard() {
  const [dash, alerts] = await Promise.all([
    get(`/api/clinics/${cid()}/dashboard`),
    get(`/api/clinics/${cid()}/alerts`),
  ]);
  const d = dash.dashboard;
  const c = clinic();
  return `
  <div class="card">
    <h2>${esc(c.name)} ${c.is_demo ? '<span class="pill">SAMPLE DATA</span>' : ''}</h2>
    <p>${esc(c.city || '')} ${esc(c.state || '')} · BAA: ${c.baa_signed ? 'signed' : '<strong>not signed</strong>'} · Payer calls: ${c.payer_calls_opt_in ? 'opted in' : 'off'} · Alerts: ${c.alerts_enabled ? 'on' : 'off'}</p>
    <div class="statgrid">
      <div class="stat"><div class="n">${money(d.recoveredThisMonth)}</div><div class="l">Recovered this month (${d.paidClaimsThisMonth} claims paid)</div></div>
      <div class="stat"><div class="n">${money(d.openAr)}</div><div class="l">Open AR (${d.openArClaims} claims)</div></div>
      <div class="stat"><div class="n">${d.openDenials}</div><div class="l">Open denials</div></div>
      <div class="stat"><div class="n">${d.authsExpiring30d}</div><div class="l">Authorizations expiring in 30 days</div></div>
      <div class="stat"><div class="n">${d.totalClaims}</div><div class="l">Total claims</div></div>
      <div class="stat"><div class="n">${d.queuedCalls}</div><div class="l">Payer calls queued</div></div>
    </div>
  </div>
  <div class="card">
    <h2>Needs attention</h2>
    ${alerts.alerts.authExpiries.length === 0 && alerts.alerts.appealDeadlines.length === 0
      ? '<p>Nothing expiring soon. Authorizations ending within 30 days and appeal deadlines within 14 days appear here.</p>'
      : `
      ${alerts.alerts.authExpiries.map((a) => `<p>⚠ Authorization <strong>${esc(a.auth_number)}</strong> (${esc(a.patient_initials)}) ends in <strong>${a.days_left} days</strong> — ${a.units_remaining} units left.</p>`).join('')}
      ${alerts.alerts.appealDeadlines.map((x) => `<p>⚠ Denial on claim #${x.claim_id} — appeal deadline in <strong>${x.days_left} days</strong> (${esc(x.appeal_deadline)}).</p>`).join('')}`}
  </div>`;
}

// --------------------------------------------------------------- patients

async function renderPatients() {
  const { patients } = await get(`/api/clinics/${cid()}/patients`);
  return `
  <div class="card">
    <h2>Patients <span class="pill">initials only — never full names, never date of birth</span></h2>
    <p>Real patients need the clinic's BAA signed first. ${clinic().baa_signed ? '' : '<strong>This clinic has not signed the BAA yet — patient entry is blocked.</strong>'}</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-patient">
      <label>Initials (e.g. A.B.)<input name="initials" required maxlength="10"></label>
      <label>Payer<input name="payer" placeholder="BCBS / Aetna / UHC"></label>
      <label>Member ID<input name="member_id"></label>
      <span></span><span></span><span></span>
      <button class="btn" type="submit">Add patient</button>
    </form>` : '<p>Viewer accounts are read-only.</p>'}
    <table><thead><tr><th>Initials</th><th>Payer</th><th>Member ID</th><th>Status</th><th></th></tr></thead>
    <tbody>${patients.map((p) => `<tr>
      <td><strong>${esc(p.initials)}</strong>${p.is_demo ? ' <span class="pill">SAMPLE</span>' : ''}</td>
      <td>${esc(p.payer)}</td><td>${esc(p.member_id)}</td><td>${pillFor(p.status)}</td>
      <td>${canWrite() ? `
        <button class="btn ghost small" data-action="discharge-patient" data-id="${p.id}" ${p.status === 'discharged' ? 'disabled' : ''}>Discharge</button>
        <button class="btn danger small" data-action="delete-patient" data-id="${p.id}">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5">No patients yet.</td></tr>'}</tbody></table>
  </div>`;
}

// -------------------------------------------------------------- referrals

async function renderReferrals() {
  const { referrals } = await get(`/api/clinics/${cid()}/referrals`);
  return `
  <div class="card">
    <h2>Referrals / Intake</h2>
    <p>New referrals come in here. Convert one into a patient in one tap when the clinic takes them on.</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-referral">
      <label>Referral initials<input name="referral_initials" required maxlength="10"></label>
      <label>Source<input name="source" placeholder="Website / Doctor / Parent"></label>
      <label>Notes<input name="notes"></label>
      <span></span>
      <button class="btn" type="submit">Add referral</button>
    </form>` : ''}
    <table><thead><tr><th>Initials</th><th>Source</th><th>Status</th><th>Notes</th><th></th></tr></thead>
    <tbody>${referrals.map((r) => `<tr>
      <td><strong>${esc(r.referral_initials)}</strong>${r.is_demo ? ' <span class="pill">SAMPLE</span>' : ''}</td>
      <td>${esc(r.source)}</td><td>${pillFor(r.status)}</td><td>${esc(r.notes)}</td>
      <td>${canWrite() ? `
        ${r.status !== 'converted' ? `<button class="btn small" data-action="convert-referral" data-id="${r.id}">Convert to patient</button>` : ''}
        <button class="btn danger small" data-action="delete-referral" data-id="${r.id}">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5">No referrals yet.</td></tr>'}</tbody></table>
    <div id="convertBox"></div>
  </div>`;
}

// ----------------------------------------------------------- verifications

async function renderVerifications() {
  await loadCache();
  const { verifications } = await get(`/api/clinics/${cid()}/verifications`);
  return `
  <div class="card">
    <h2>Eligibility verifications</h2>
    <p>Check coverage before the first session. EDI 270/271 references fill in when the clearinghouse goes live.</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-verification">
      <label>Patient<select name="patient_id">${patientOptions()}</select></label>
      <label>Payer<input name="payer"></label>
      <label>Status<select name="status"><option>pending</option><option>eligible</option><option>ineligible</option></select></label>
      <label>Coverage start<input name="coverage_start" type="date"></label>
      <label>Coverage end<input name="coverage_end" type="date"></label>
      <label>Notes<input name="notes"></label>
      <button class="btn" type="submit">Add verification</button>
    </form>` : ''}
    <table><thead><tr><th>Patient</th><th>Payer</th><th>Status</th><th>Coverage</th><th>Notes</th></tr></thead>
    <tbody>${verifications.map((v) => `<tr>
      <td><strong>${esc(v.patient_initials)}</strong></td><td>${esc(v.payer)}</td><td>${pillFor(v.status)}</td>
      <td>${esc(v.coverage_start || '')} → ${esc(v.coverage_end || '')}</td><td>${esc(v.notes)}</td>
    </tr>`).join('') || '<tr><td colspan="5">No verifications yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ---------------------------------------------------------- authorizations

async function renderAuthorizations() {
  await loadCache();
  const { authorizations } = await get(`/api/clinics/${cid()}/authorizations`);
  return `
  <div class="card">
    <h2>Authorizations</h2>
    <p>Unit tracking + 30 / 14 / 7-day expiry alerts. A claim cannot use more units than the authorization has left.</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-authorization">
      <label>Patient<select name="patient_id">${patientOptions()}</select></label>
      <label>Auth number<input name="auth_number" required></label>
      <label>Payer<input name="payer"></label>
      <label>CPT codes (comma separated)<input name="cpt_codes" placeholder="97153,97155"></label>
      <label>Total units<input name="total_units" type="number" min="0" value="0"></label>
      <label>Units used<input name="units_used" type="number" min="0" value="0"></label>
      <label>Start date<input name="start_date" type="date"></label>
      <label>End date<input name="end_date" type="date"></label>
      <button class="btn" type="submit">Add authorization</button>
    </form>` : ''}
    <table><thead><tr><th>Auth #</th><th>Patient</th><th>CPTs</th><th>Units left</th><th>Ends</th><th>Status</th><th></th></tr></thead>
    <tbody>${authorizations.map((a) => `<tr>
      <td><strong>${esc(a.auth_number)}</strong></td><td>${esc(a.patient_initials)}</td>
      <td>${esc(a.cpt_codes)}</td><td>${a.units_remaining} / ${a.total_units}</td>
      <td>${esc(a.end_date || '')} ${a.days_left !== null && a.days_left <= 30 ? `<span class="pill warn">${a.days_left}d left</span>` : ''}</td>
      <td>${pillFor(a.status)}</td>
      <td>${canWrite() ? `
        <button class="btn ghost small" data-action="use-units" data-id="${a.id}" data-used="${a.units_used}">Log units used</button>
        <button class="btn danger small" data-action="delete-auth" data-id="${a.id}">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7">No authorizations yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ---------------------------------------------------------------- sessions

async function renderSessions() {
  await loadCache();
  const { sessions } = await get(`/api/clinics/${cid()}/sessions`);
  return `
  <div class="card">
    <h2>Sessions</h2>
    <p>A completed session becomes a draft claim in one tap.</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-session">
      <label>Patient<select name="patient_id">${patientOptions()}</select></label>
      <label>Authorization<select name="authorization_id"><option value="">— none —</option>${(state.cache.auths || []).map((a) => `<option value="${a.id}">${esc(a.auth_number)} (${esc(a.patient_initials)})</option>`).join('')}</select></label>
      <label>Session date<input name="session_date" type="date" required></label>
      <label>CPT<select name="cpt_code">${CPTS.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>Units<input name="units" type="number" min="0" value="4"></label>
      <label>Duration (min)<input name="duration_min" type="number" min="0" value="60"></label>
      <label>Status<select name="status"><option>scheduled</option><option selected>completed</option><option>cancelled</option></select></label>
      <button class="btn" type="submit">Add session</button>
    </form>` : ''}
    <table><thead><tr><th>Date</th><th>Patient</th><th>CPT</th><th>Units</th><th>Status</th><th></th></tr></thead>
    <tbody>${sessions.map((s) => `<tr>
      <td>${esc(s.session_date)}</td><td><strong>${esc(s.patient_initials)}</strong></td>
      <td>${esc(s.cpt_code)}</td><td>${s.units}</td><td>${pillFor(s.status)}</td>
      <td>${canWrite() ? `
        ${s.status === 'completed' && !s.claim_id ? `<button class="btn small" data-action="session-to-claim" data-id="${s.id}">Create claim</button>` : ''}
        ${s.claim_id ? `<span class="muted">Claim #${s.claim_id}</span>` : ''}
        <button class="btn danger small" data-action="delete-session" data-id="${s.id}">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6">No sessions yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ------------------------------------------------------------------ claims

async function renderClaims() {
  await loadCache();
  const filter = state.claimFilter || '';
  const { claims } = await get(`/api/clinics/${cid()}/claims${filter ? '?status=' + filter : ''}`);
  return `
  <div class="card">
    <h2>Claims <span class="pill sim">Simulation mode — submit goes to the built-in simulator, not a real clearinghouse</span></h2>
    <p>Every claim is scrubbed automatically before it can be submitted. A failed scrub blocks submission until it is fixed.</p>
    <div class="btnrow">
      <label>Filter <select id="claimFilter"><option value="">All statuses</option>${['draft', 'ready', 'submitted', 'partial', 'paid', 'denied'].map((s) => `<option ${filter === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    </div>
    ${canWrite() ? `
    <form class="grid" data-form="add-claim">
      <label>Patient<select name="patient_id">${patientOptions()}</select></label>
      <label>Authorization<select name="authorization_id"><option value="">— none —</option>${(state.cache.auths || []).map((a) => `<option value="${a.id}">${esc(a.auth_number)} (${esc(a.patient_initials)})</option>`).join('')}</select></label>
      <label>Date of service<input name="date_of_service" type="date" required></label>
      <label>CPT<select name="cpt_code">${CPTS.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>Units<input name="units" type="number" min="0" value="4"></label>
      <label>Billed amount ($)<input name="billed_amount" type="number" min="0" step="0.01" value="0"></label>
      <label>Notes<input name="notes"></label>
      <button class="btn" type="submit">Add claim</button>
    </form>` : ''}
    <table><thead><tr><th>#</th><th>Patient</th><th>DOS</th><th>CPT</th><th>Units</th><th>Billed</th><th>Paid</th><th>Status</th><th>Scrub</th><th>Risk</th><th></th></tr></thead>
    <tbody>${claims.map((c) => `<tr>
      <td><strong>#${c.id}</strong>${c.payer_claim_number ? `<br><span class="muted">${esc(c.payer_claim_number)}</span>` : ''}</td>
      <td>${esc(c.patient_initials)}</td><td>${esc(c.date_of_service)}</td><td>${esc(c.cpt_code)}</td>
      <td>${c.units}</td><td>${money(c.billed_amount)}</td><td>${money(c.paid_amount)}</td>
      <td>${pillFor(c.status)}</td>
      <td>${pillFor(c.scrub_status)}${c.scrub_errors && c.scrub_errors.length ? `<details><summary>${c.scrub_errors.length} issue(s)</summary><ul class="errlist">${c.scrub_errors.map((e) => `<li><strong>${esc(e.severity)}:</strong> ${esc(e.message)}</li>`).join('')}</ul></details>` : ''}</td>
      <td>${c.risk_score !== null && c.risk_score !== undefined
        ? `<strong>${c.risk_score}</strong> ${pillFor(c.risk_score >= 50 ? 'failed' : c.risk_score >= 25 ? 'pending' : 'passed')}${c.risk_factors && c.risk_factors.length ? `<details><summary>${c.risk_factors.length} factor(s)</summary><ul class="errlist">${c.risk_factors.map((f) => `<li><strong>+${f.points}:</strong> ${esc(f.message)}</li>`).join('')}</ul></details>` : ''}`
        : '<span class="muted">not scored</span>'}</td>
      <td>${canWrite() ? `
        <button class="btn ghost small" data-action="score-claim" data-id="${c.id}">Score risk</button>
        <button class="btn ghost small" data-action="scrub-claim" data-id="${c.id}">Scrub</button>
        ${['draft', 'ready'].includes(c.status) ? `<button class="btn small" data-action="submit-claim" data-id="${c.id}">Submit</button>` : ''}
        <button class="btn ghost small" data-action="duplicate-claim" data-id="${c.id}">Duplicate</button>
        ${['submitted', 'partial', 'denied'].includes(c.status) ? `<button class="btn ghost small" data-action="record-payment" data-id="${c.id}">Record payment</button>` : ''}
        ${['submitted', 'partial', 'paid', 'denied'].includes(c.status) ? `<button class="btn ghost small" data-action="edi-status-check" data-id="${c.id}">276/277 check</button>` : ''}
        <button class="btn danger small" data-action="delete-claim" data-id="${c.id}">Delete</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="11">No claims yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ----------------------------------------------------------------- denials

async function renderDenials() {
  await loadCache();
  const { denials } = await get(`/api/clinics/${cid()}/denials`);
  return `
  <div class="card">
    <h2>Denials &amp; appeals</h2>
    <p>Track every denial and its appeal deadline. Denials older than the deadline need a decision: appeal or write off.</p>
    ${canWrite() ? `
    <form class="grid" data-form="add-denial">
      <label>Claim<select name="claim_id">${claimOptions()}</select></label>
      <label>Denial code<input name="denial_code" placeholder="CO-97 / CO-197"></label>
      <label>Reason<input name="reason"></label>
      <label>Appeal deadline<input name="appeal_deadline" type="date"></label>
      <label>Notes<input name="notes"></label>
      <button class="btn" type="submit">Add denial</button>
    </form>` : ''}
    <table><thead><tr><th>Claim</th><th>Code</th><th>Reason</th><th>Deadline</th><th>Status</th><th></th></tr></thead>
    <tbody>${denials.map((d) => `<tr>
      <td>#${d.claim_id} · ${esc(d.patient_initials)} · ${esc(d.cpt_code)} · ${money(d.billed_amount)}</td>
      <td><strong>${esc(d.denial_code)}</strong></td><td>${esc(d.reason)}</td>
      <td>${esc(d.appeal_deadline || '')}</td><td>${pillFor(d.status)}</td>
      <td>${canWrite() ? `<select data-action="denial-status" data-id="${d.id}">
        ${['open', 'appealing', 'appealed', 'written-off'].map((s) => `<option ${d.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6">No denials — good news.</td></tr>'}</tbody></table>
  </div>`;
}

// ---------------------------------------------------------------- appeals

async function renderAppeals() {
  await loadCache();
  const [drafts, denials] = await Promise.all([
    get(`/api/clinics/${cid()}/appeal-drafts`),
    get(`/api/clinics/${cid()}/denials`),
  ]);
  const selected = state.selectedAppeal ? drafts.drafts.find((d) => d.id === state.selectedAppeal) : null;
  return `
  <div class="card">
    <h2>Appeal drafts</h2>
    <p>Generate a payer-specific appeal letter from a denial, edit it, then mark it filed. Filing moves the denial to “appealing”. Deleting a draft never deletes the denial.</p>
    ${canWrite() ? `
    <h3>Generate a draft</h3>
    <form class="grid" data-form="appeal-generate">
      <label>Denial<select name="denial_id">${denials.denials.filter((d) => d.status !== 'written-off').map((d) => `<option value="${d.id}">Claim #${d.claim_id} · ${esc(d.denial_code || '')} · ${esc(d.patient_initials)} · deadline ${esc(d.appeal_deadline || '—')}</option>`).join('') || '<option value="">No denials to appeal</option>'}</select></label>
      <button class="btn" type="submit">Generate draft</button>
    </form>` : ''}
    ${selected ? `
    <h3>Edit draft #${selected.id} (${esc(selected.template)})</h3>
    <form data-form="edit-appeal">
      <input type="hidden" name="draft_id" value="${selected.id}">
      <label>Letter text<textarea name="draft_text" rows="14" style="width:100%">${esc(selected.draft_text)}</textarea></label>
      <div class="btnrow">
        <label>Status <select name="status"><option value="draft" ${selected.status === 'draft' ? 'selected' : ''}>draft</option><option value="ready" ${selected.status === 'ready' ? 'selected' : ''}>ready</option></select></label>
        <button class="btn" type="submit">Save draft</button>
        <button class="btn ghost" type="button" data-action="appeal-edit-cancel">Close editor</button>
      </div>
    </form>` : ''}
    <table><thead><tr><th>#</th><th>Claim</th><th>Denial</th><th>Template</th><th>Status</th><th></th></tr></thead>
    <tbody>${drafts.drafts.map((d) => `<tr>
      <td><strong>#${d.id}</strong></td>
      <td>#${d.claim_id} · ${esc(d.patient_initials)} · ${esc(d.cpt_code)} · ${esc(d.date_of_service)}</td>
      <td>${esc(d.denial_code || '')} · ${pillFor(d.denial_status)}</td>
      <td>${esc(d.template)}</td><td>${pillFor(d.status)}</td>
      <td>${canWrite() ? `
        <a class="btn ghost small" href="/api/clinics/${cid()}/appeal-drafts/${d.id}/download">Download</a>
        ${d.status !== 'filed' ? `<button class="btn ghost small" data-action="appeal-edit" data-id="${d.id}">Edit</button>
        <button class="btn small" data-action="appeal-file" data-id="${d.id}">Mark filed</button>
        <button class="btn danger small" data-action="appeal-delete" data-id="${d.id}">Delete</button>` : ''}` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6">No appeal drafts yet — generate one from a denial above.</td></tr>'}</tbody></table>
  </div>`;
}

// ------------------------------------------------------------- payer calls

async function renderCalls() {
  await loadCache();
  const c = clinic();
  const [queue, calls] = await Promise.all([
    get(`/api/clinics/${cid()}/call-queue`),
    get(`/api/clinics/${cid()}/payer-calls`),
  ]);
  return `
  <div class="card">
    <h2>Payer calls ${c.payer_calls_opt_in ? '<span class="pill ok">Opted in</span>' : '<span class="pill bad">Opted out</span>'}</h2>
    <p>Payer calls only happen for clinics that opt in. Each queued claim carries the exact question to ask. <span class="pill sim">Simulation mode — no live Twilio call is placed yet.</span></p>
    ${isOwner() ? `<div class="btnrow"><button class="btn ghost" data-action="toggle-optin">${c.payer_calls_opt_in ? 'Turn payer calls OFF' : 'Turn payer calls ON (opt in)'}</button></div>` : ''}
    <h3>Sara dialer bridge</h3>
    <p>Export the queue as a CSV for Sara’s dialer, then import the call results file back — outcomes land on the claims automatically.</p>
    <div class="btnrow">
      <a class="btn ghost" href="/api/clinics/${cid()}/call-queue/export">Export queue (CSV)</a>
    </div>
    ${c.payer_calls_opt_in && canWrite() ? `
    <form class="grid" data-form="import-calls">
      <label>Call results file (CSV)<input type="file" name="file" accept=".csv,text/csv" required></label>
      <span></span><span></span>
      <button class="btn" type="submit">Import call results</button>
    </form>
    <div id="importResults"></div>` : ''}
    ${c.payer_calls_opt_in && canWrite() ? `
    <form class="grid" data-form="add-queue">
      <label>Claim<select name="claim_id">${claimOptions()}</select></label>
      <label>Exact question to ask the payer<input name="question" placeholder="Why was this claim denied for CO-197?"></label>
      <button class="btn" type="submit">Queue call</button>
    </form>` : ''}
    <h3>Queue</h3>
    <table><thead><tr><th>Claim</th><th>Question</th><th>Status</th><th></th></tr></thead>
    <tbody>${queue.queue.map((q) => `<tr>
      <td>#${q.claim_id} · ${esc(q.patient_initials)} · ${esc(q.cpt_code)} · ${money(q.billed_amount)}</td>
      <td>${esc(q.question)}</td><td>${pillFor(q.status)}</td>
      <td>${canWrite() && q.status === 'queued' ? `<button class="btn danger small" data-action="cancel-queue" data-id="${q.id}">Cancel</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4">Queue is empty.</td></tr>'}</tbody></table>
    ${c.payer_calls_opt_in && canWrite() ? `
    <h3>Log a call</h3>
    <form class="grid" data-form="log-call">
      <label>Claim<select name="claim_id">${claimOptions()}</select></label>
      <label>Caller<select name="caller"><option value="team">Team</option><option value="sara">Sara (AI)</option></select></label>
      <label>Outcome<select name="outcome"><option>paid</option><option>denied</option><option>partial</option><option>pending</option><option>info-received</option></select></label>
      <label>Status answer<input name="status_answer" placeholder="What the payer said"></label>
      <label>Reference number<input name="reference_number"></label>
      <label>Next action<input name="next_action"></label>
      <button class="btn" type="submit">Log call</button>
    </form>` : ''}
    <h3>Call log</h3>
    <table><thead><tr><th>When</th><th>Claim</th><th>Caller</th><th>Outcome</th><th>Answer / ref</th><th>Next action</th></tr></thead>
    <tbody>${calls.calls.map((x) => `<tr>
      <td>${esc((x.called_at || '').slice(0, 10))}</td><td>#${x.claim_id} · ${esc(x.patient_initials)}</td>
      <td>${esc(x.caller)}${x.is_simulated ? ' <span class="pill sim">SIM</span>' : ''}</td>
      <td>${pillFor(x.outcome)}</td><td>${esc(x.status_answer)}${x.reference_number ? '<br>Ref: ' + esc(x.reference_number) : ''}</td>
      <td>${esc(x.next_action)}</td>
    </tr>`).join('') || '<tr><td colspan="6">No calls logged yet.</td></tr>'}</tbody></table>
  </div>`;
}

// --------------------------------------------------------------------- ERA

async function renderEra() {
  const { era } = await get(`/api/clinics/${cid()}/era`);
  return `
  <div class="card">
    <h2>ERA / payment posting <span class="pill">financial records — ERA lines are never deleted</span></h2>
    <p>Import an ERA file (CSV with payer_claim_number, patient_initials, date_of_service, cpt_code, paid_amount). Lines auto-match by payer claim number first, then by patient + date + CPT. Unmatched lines stay listed until matched by hand.</p>
    ${canWrite() ? `
    <form class="grid" data-form="era-import">
      <label>ERA file (CSV)<input type="file" name="file" accept=".csv,text/csv" required></label>
      <span></span><span></span>
      <button class="btn" type="submit">Import ERA</button>
    </form>
    <div id="eraPreview"></div>` : ''}
    <table><thead><tr><th>Payer claim #</th><th>Patient</th><th>DOS</th><th>CPT</th><th>Paid</th><th>Status</th><th></th></tr></thead>
    <tbody>${era.map((e) => `<tr>
      <td>${esc(e.payer_claim_number)}</td><td>${esc(e.patient_initials)}</td><td>${esc(e.date_of_service)}</td>
      <td>${esc(e.cpt_code)}</td><td>${money(e.paid_amount)}</td><td>${pillFor(e.status)}</td>
      <td>${canWrite() ? `
        ${e.status === 'unmatched' ? `<button class="btn small" data-action="match-era" data-id="${e.id}">Match to claim</button>` : ''}
        ${e.status === 'matched' ? `<button class="btn small" data-action="post-era" data-id="${e.id}">Post payment</button>` : ''}
      ` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7">No ERA lines yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ------------------------------------------------------------- AR & reports

async function renderAr() {
  const [ar, report] = await Promise.all([
    get(`/api/clinics/${cid()}/ar`),
    get(`/api/clinics/${cid()}/reports/weekly`),
  ]);
  const b = ar.ar.buckets;
  return `
  <div class="card">
    <h2>AR aging — oldest first</h2>
    <div class="statgrid">
      ${Object.entries(b).map(([k, v]) => `<div class="stat"><div class="n">${money(v.balance)}</div><div class="l">${k} days · ${v.count} claim(s)</div></div>`).join('')}
    </div>
    <table><thead><tr><th>Patient</th><th>DOS</th><th>CPT</th><th>Billed</th><th>Paid</th><th>Balance</th><th>Age</th><th>Status</th></tr></thead>
    <tbody>${ar.ar.items.map((c) => `<tr>
      <td><strong>${esc(c.patient_initials)}</strong></td><td>${esc(c.date_of_service)}</td><td>${esc(c.cpt_code)}</td>
      <td>${money(c.billed_amount)}</td><td>${money(c.paid_amount)}</td><td><strong>${money(c.balance)}</strong></td>
      <td>${c.age_days}d</td><td>${pillFor(c.status)}</td>
    </tr>`).join('') || '<tr><td colspan="8">No open AR — everything is paid.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <h2>Weekly report</h2>
    <div class="statgrid">
      <div class="stat"><div class="n">${report.report.week.claimsCreated}</div><div class="l">Claims created (7d)</div></div>
      <div class="stat"><div class="n">${report.report.week.claimsSubmitted}</div><div class="l">Claims submitted (7d)</div></div>
      <div class="stat"><div class="n">${money(report.report.week.recovered)}</div><div class="l">Recovered (7d)</div></div>
      <div class="stat"><div class="n">${report.report.week.denialsOpened}</div><div class="l">Denials opened (7d)</div></div>
      <div class="stat"><div class="n">${money(report.report.totals.totalRecovered)}</div><div class="l">Total recovered to date</div></div>
      <div class="stat"><div class="n">${money(report.report.totals.openAr)}</div><div class="l">Open AR total</div></div>
    </div>
  </div>`;
}

// ----------------------------------------------------------- import/export

async function renderImport() {
  return `
  <div class="card">
    <h2>Bulk import — CSV</h2>
    <p>Import patients, referrals, authorizations, claims or sessions. Download the template, fill it in Excel or Sheets, save as CSV, upload here. Full names and dates of birth are rejected — initials only.</p>
    <form class="grid" data-form="csv-import">
      <label>Type<select name="type"><option value="patients">Patients</option><option value="referrals">Referrals</option><option value="authorizations">Authorizations</option><option value="claims">Claims</option><option value="sessions">Sessions</option></select></label>
      <label>CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
      <span></span>
      <button class="btn" type="submit">Check rows (preview)</button>
    </form>
    <div id="csvPreview"></div>
    <h3>Templates</h3>
    <div class="btnrow">
      ${['patients', 'referrals', 'authorizations', 'claims', 'sessions'].map((t) =>
        `<a class="btn ghost" href="/api/clinics/${cid()}/templates/${t}">${t} template</a>`).join('')}
    </div>
    <h3>Export</h3>
    <div class="btnrow">
      ${['patients', 'referrals', 'authorizations', 'claims', 'sessions', 'ar'].map((t) =>
        `<a class="btn ghost" href="/api/clinics/${cid()}/export/${t}">Export ${t}</a>`).join('')}
    </div>
  </div>`;
}

// ------------------------------------------------------------------- audit

async function renderAudit() {
  const { audit: rows } = await get(`/api/clinics/${cid()}/audit?limit=200`);
  return `
  <div class="card">
    <h2>Audit log <span class="pill">append-only — entries are never edited or deleted</span></h2>
    <table><thead><tr><th>When</th><th>Who</th><th>Role</th><th>What</th><th>Detail</th></tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td>${esc((a.created_at || '').slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(a.actor_name)}</td><td>${esc(a.actor_role)}</td>
      <td>${esc(a.action)} ${esc(a.entity)}${a.entity_id ? ' #' + a.entity_id : ''}</td>
      <td class="muted">${esc(JSON.stringify(a.detail || {}))}</td>
    </tr>`).join('') || '<tr><td colspan="5">No audit entries yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ---------------------------------------------------------------- settings

async function renderSettings() {
  const c = clinic();
  const users = isOwner() ? (await get(`/api/clinics/${cid()}/users`)).users : [];
  const digests = isOwner() ? (await get(`/api/clinics/${cid()}/alert-digests?limit=10`)).digests : [];
  return `
  <div class="card">
    <h2>Clinic settings</h2>
    ${isOwner() ? `
    <form class="grid" data-form="clinic-flags">
      <label class="check"><input type="checkbox" name="baa_signed" ${c.baa_signed ? 'checked' : ''}> BAA signed (allows real patient data)</label>
      <label class="check"><input type="checkbox" name="payer_calls_opt_in" ${c.payer_calls_opt_in ? 'checked' : ''}> Payer calls opted in (Sara / team may call payers)</label>
      <label class="check"><input type="checkbox" name="alerts_enabled" ${c.alerts_enabled ? 'checked' : ''}> Email alerts enabled</label>
      <label>Alert email<input name="alert_email" type="email" value="${esc(c.alert_email || '')}"></label>
      <label>Contact name<input name="contact_name" value="${esc(c.contact_name || '')}"></label>
      <label>Contact email<input name="contact_email" type="email" value="${esc(c.contact_email || '')}"></label>
      <label>City<input name="city" value="${esc(c.city || '')}"></label>
      <label>State<input name="state" value="${esc(c.state || '')}"></label>
      <button class="btn" type="submit">Save settings</button>
    </form>` : '<p>Only the clinic owner can change these settings.</p>'}
  </div>
  ${isOwner() ? `
  <div class="card">
    <h2>Subscription</h2>
    <p>Status: <strong>${esc(c.subscription_status)}</strong> · Plan: ${esc(c.subscription_plan)} · Trial ends: ${esc(c.trial_ends_at || '—')}</p>
    <div class="btnrow"><button class="btn ghost" data-action="goto-subscribe">Manage subscription</button></div>
  </div>` : ''}
  ${isOwner() ? `
  <div class="card">
    <h2>Email alert digests</h2>
    <p>One digest per day, when there is something to report. Delivery is recorded honestly — “sent” only after the email is accepted, “failed” with the reason otherwise. ${c.alerts_enabled ? '' : '<strong>Alerts are currently off for this clinic.</strong>'}</p>
    <div class="btnrow"><button class="btn ghost" data-action="send-digest">Send today's digest now</button></div>
    <table><thead><tr><th>Date</th><th>Items</th><th>Status</th><th>Detail</th></tr></thead>
    <tbody>${digests.map((d) => `<tr>
      <td>${esc(d.digest_date)}</td><td>${d.itemCount}</td><td>${pillFor(d.status === 'sent' ? 'passed' : d.status === 'failed' ? 'failed' : 'pending')}</td>
      <td class="muted">${esc(d.error || (d.sent_at ? 'sent ' + d.sent_at.slice(0, 19).replace('T', ' ') : 'queued'))}</td>
    </tr>`).join('') || '<tr><td colspan="4">No digests yet.</td></tr>'}</tbody></table>
  </div>` : ''}
  ${isOwner() ? `
  <div class="card">
    <h2>Clinic users</h2>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
      <td>${u.id !== state.user.id ? `<button class="btn danger small" data-action="delete-user" data-id="${u.id}">Remove</button>` : '<span class="muted">you</span>'}</td></tr>`).join('')}</tbody></table>
    <form class="grid" data-form="add-user">
      <label>Name<input name="name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Password (8+)<input name="password" type="password" minlength="8" required></label>
      <label>Role<select name="role"><option>biller</option><option>viewer</option><option>owner</option></select></label>
      <button class="btn" type="submit">Add user</button>
    </form>
  </div>` : ''}
  ${isZenvyOwner() ? `
  <div class="card">
    <h2>Demo data</h2>
    <p>Load a clearly-labelled sample clinic to show the platform working — no real patients. Remove it any time.</p>
    <div class="btnrow">
      <button class="btn" data-action="demo-load">Load demo data</button>
      <button class="btn danger" data-action="demo-remove">Remove demo data</button>
    </div>
  </div>` : ''}
  ${isZenvyOwner() ? `
  <div class="card">
    <h2>New clinic</h2>
    <form class="grid" data-form="add-clinic">
      <label>Clinic name<input name="name" required></label>
      <label>City<input name="city"></label>
      <label>State<input name="state"></label>
      <label>Contact email<input name="contact_email" type="email"></label>
      <button class="btn" type="submit">Create clinic</button>
    </form>
  </div>` : ''}`;
}

// ------------------------------------------------------------- subscribe

async function renderSubscribe() {
  const c = clinic();
  const { subscription: s } = await get(`/api/clinics/${cid()}/subscription`);
  const statusPill = { none: '', trial: 'warn', active: 'ok', paused: 'warn', cancelled: 'bad' }[s.status] || '';
  const actions = [];
  if (s.status === 'none' || s.status === 'cancelled') {
    actions.push(`<button class="btn" data-action="sub-trial">Start 14-day free trial (no card)</button>`);
    actions.push(`<button class="btn ghost" data-action="sub-activate">Subscribe now — $500/month</button>`);
  }
  if (s.status === 'trial') {
    actions.push(`<button class="btn" data-action="sub-activate">Activate — $500/month</button>`);
    actions.push(`<button class="btn ghost" data-action="sub-pause">Pause trial</button>`);
    actions.push(`<button class="btn danger" data-action="sub-cancel">Cancel</button>`);
  }
  if (s.status === 'active') {
    actions.push(`<button class="btn ghost" data-action="sub-pause">Pause subscription</button>`);
    actions.push(`<button class="btn danger" data-action="sub-cancel">Cancel subscription</button>`);
  }
  if (s.status === 'paused') {
    actions.push(`<button class="btn" data-action="sub-resume">Resume subscription</button>`);
    actions.push(`<button class="btn danger" data-action="sub-cancel">Cancel subscription</button>`);
  }
  return `
  <div class="card">
    <h2>Subscribe — Zenvy Billing Platform <span class="pill ${statusPill}">${esc(s.status)}</span></h2>
    <p>${esc(c.name)} · Plan: <strong>${esc(s.plan)}</strong> · <strong>$${s.priceMonthly}/month</strong>${s.trialEndsAt ? ` · Trial ends: <strong>${esc(s.trialEndsAt)}</strong>` : ''}</p>
    <p>Paddle: ${s.paddle.configured ? esc(s.paddle.mode) : '<strong>not connected yet</strong> — checkout runs in sandbox until Paddle is connected. No real charges are possible right now.'}</p>
    <div class="btnrow">${actions.join('')}</div>
  </div>
  <div class="card">
    <h2>What you get for $500/month</h2>
    <ul>
      <li>Authorizations tracked before they expire (30 / 14 / 7-day alerts)</li>
      <li>Claims scrubbed before submission — a failed scrub blocks the submit</li>
      <li>Denials followed up, oldest first, with appeal deadlines</li>
      <li>Payer calls by Sara — only if your clinic opts in (off by default)</li>
      <li>Email alert digests, CSV import/export, weekly reports</li>
      <li>Free onboarding and data-import help — we set your clinic up with you</li>
    </ul>
    <h3>Does it pay for itself?</h3>
    <p>One $240 paid claim covers almost half a month. Most clinics recover the $500 from a single overturned denial — if it does not recover more than it costs, you walk away. That is the deal.</p>
    <h3>Honest answers</h3>
    <ul>
      <li><strong>Trial:</strong> 14 days, no card. Try it with the demo data first.</li>
      <li><strong>Contract:</strong> none — month-to-month, cancel any time.</li>
      <li><strong>Your data:</strong> export it any time (CSV). We never hold it hostage.</li>
      <li><strong>Real patient data:</strong> only after your BAA is signed — the platform blocks it before then.</li>
      <li><strong>Payer calls:</strong> opt-in only. Nothing calls a payer unless you turn it on.</li>
    </ul>
  </div>`;
}

// ------------------------------------------------------------ automation

async function renderAutomation() {
  const [{ rules }, { runs }] = await Promise.all([
    get('/api/automation/rules'),
    get('/api/automation/runs?limit=20'),
  ]);
  return `
  <div class="card">
    <h2>Automation <span class="pill">Zenvy owner only</span></h2>
    <p>Five rules run every morning in the daily sweep. Turn any rule off and the sweep skips it; run history is below.</p>
    <p class="muted">Daily sweep: automated checks ~07:45 PKT, alert digest ~08:30 PKT — triggered by an external scheduler calling <code>POST /api/internal/run-daily</code> (CRON_SECRET header). Render free has no cron jobs, so the endpoint is the schedule.</p>
    <div class="btnrow"><button class="btn" data-action="run-daily">Run daily sweep now</button></div>
    <table><thead><tr><th>Rule</th><th>On</th><th>Last run</th></tr></thead>
    <tbody>${rules.map((r) => `<tr>
      <td><strong>${esc(r.label)}</strong></td>
      <td><input type="checkbox" data-rule="${esc(r.key)}" ${r.enabled ? 'checked' : ''}></td>
      <td>${esc(r.lastRunAt ? r.lastRunAt.slice(0, 19).replace('T', ' ') : 'never')}</td>
    </tr>`).join('')}</tbody></table>
  </div>
  <div class="card">
    <h2>Run history</h2>
    <table><thead><tr><th>When</th><th>Rule</th><th>Result</th><th>Error</th></tr></thead>
    <tbody>${runs.map((x) => `<tr>
      <td>${esc((x.started_at || '').slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(x.label || x.rule_key)}</td>
      <td class="muted">${esc(JSON.stringify(x.result || {}))}</td>
      <td>${esc(x.error || '')}</td>
    </tr>`).join('') || '<tr><td colspan="4">No runs yet.</td></tr>'}</tbody></table>
  </div>`;
}

// ------------------------------------------------------------------ costs

async function renderCosts() {
  const { costs } = await get('/api/zenvy/costs');
  return `
  <div class="card">
    <h2>Costs &amp; Model <span class="pill">Zenvy owner only — clinics never see this page</span></h2>
    <p>What the platform costs to run, and what it earns. Price: <strong>$${costs.priceMonthly}/month per clinic</strong>, ${costs.trialDays}-day free trial, no card.</p>
    <table><thead><tr><th>Cost</th><th>Per month</th></tr></thead>
    <tbody>${costs.monthlyCosts.map((c) => `<tr><td>${esc(c.item)}</td><td>${esc(c.cost)}</td></tr>`).join('')}</tbody></table>
    <h3>Profit</h3>
    <table><thead><tr><th>Clinics</th><th>Revenue</th><th>Paddle fees</th><th>Hosting</th><th>Net</th><th></th></tr></thead>
    <tbody>${costs.profit.map((p) => `<tr>
      <td><strong>${p.clinics}</strong></td><td>$${p.revenue.toLocaleString()}</td><td>$${p.paddleFees}</td>
      <td>$${p.hosting}</td><td><strong>$${p.net.toLocaleString()}</strong></td><td>${esc(p.note)}</td>
    </tr>`).join('')}</tbody></table>
    <ul>${costs.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </div>`;
}

// ----------------------------------------------------------- integrations

async function renderIntegrations() {
  await loadCache();
  const [{ integrations, simulation, note }, batches] = await Promise.all([
    get('/api/integrations'),
    get(`/api/clinics/${cid()}/edi/batches`),
  ]);
  return `
  <div class="card">
    <h2>Integrations <span class="pill sim">Simulation mode — no live vendor connection yet</span></h2>
    <p>${esc(note)}</p>
    <table><thead><tr><th>Vendor</th><th>What it does</th><th>EDI</th><th>Mode</th><th>Authorization steps (clinic must complete)</th><th></th></tr></thead>
    <tbody>${integrations.map((v) => `<tr>
      <td><strong>${esc(v.label)}</strong><br><span class="muted">${esc(v.kind)}</span></td>
      <td>${esc(v.what)}</td><td>${esc(v.edi)}</td>
      <td>${pillFor(v.mode === 'live' ? 'passed' : v.mode === 'simulation' ? 'pending' : 'draft')}<br><span class="muted">${esc(v.mode)}</span></td>
      <td><ol>${v.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></td>
      <td>${isZenvyOwner() ? `
        ${v.mode !== 'simulation' ? `<button class="btn ghost small" data-action="conn-mode" data-id="${v.vendor}" data-mode="simulation">Set simulation</button>` : ''}
        ${v.mode !== 'off' ? `<button class="btn ghost small" data-action="conn-mode" data-id="${v.vendor}" data-mode="off">Turn off</button>` : ''}
        <button class="btn small" data-action="conn-mode" data-id="${v.vendor}" data-mode="live">Request live</button>` : '<span class="muted">Zenvy owner only</span>'}</td>
    </tr>`).join('')}</tbody></table>
  </div>
  <div class="card">
    <h2>EDI — batches &amp; status checks</h2>
    <p>837 claim batches go out through the clearinghouse (simulation for now). 270/271 eligibility references live on each verification; 835 ERA import is on the ERA tab. Use the 276/277 check to ask the clearinghouse where a submitted claim stands.</p>
    ${canWrite() ? `
    <form class="grid" data-form="edi-status-check">
      <label>Claim<select name="claim_id">${(state.cache.claims || []).filter((c) => ['submitted', 'partial', 'paid', 'denied'].includes(c.status)).map((c) => `<option value="${c.id}">#${c.id} · ${esc(c.cpt_code)} · ${esc(c.date_of_service)} · ${esc(c.status)}</option>`).join('') || '<option value="">No submitted claims</option>'}</select></label>
      <button class="btn" type="submit">Run 276/277 check</button>
    </form>
    <div id="ediResult"></div>` : ''}
    <h3>837 batches</h3>
    <table><thead><tr><th>Batch</th><th>Claims</th><th>Billed</th><th>Paid</th></tr></thead>
    <tbody>${batches.batches.map((b) => `<tr>
      <td><strong>${esc(b.batchRef)}</strong> <span class="pill sim">SIM</span></td>
      <td>${b.claimCount}</td><td>${money(b.totalBilled)}</td><td>${money(b.totalPaid)}</td>
    </tr>`).join('') || '<tr><td colspan="4">No batches yet — submit a claim first.</td></tr>'}</tbody></table>
  </div>`;
}

// ------------------------------------------------------------------ portal

async function renderPortal() {
  const { portal } = await get('/api/portal');
  const d = portal.dashboard;
  return `
  <div class="card">
    <h2>${esc(portal.clinic.name)} — Clinic Portal</h2>
    <p>Your clinic’s billing at a glance. This view shows only your clinic’s data — nothing from any other clinic.</p>
    <p>Subscription: <strong>${esc(portal.subscription.status)}</strong> · $${portal.subscription.priceMonthly}/month${portal.subscription.trialEndsAt ? ` · trial ends ${esc(portal.subscription.trialEndsAt)}` : ''}</p>
    <div class="statgrid">
      <div class="stat"><div class="n">${money(d.recoveredThisMonth)}</div><div class="l">Recovered this month</div></div>
      <div class="stat"><div class="n">${money(d.openAr)}</div><div class="l">Open AR (${d.openArClaims} claims)</div></div>
      <div class="stat"><div class="n">${d.openDenials}</div><div class="l">Open denials</div></div>
      <div class="stat"><div class="n">${d.authsExpiring30d}</div><div class="l">Auths expiring in 30 days</div></div>
      <div class="stat"><div class="n">${d.queuedCalls}</div><div class="l">Payer calls queued</div></div>
    </div>
  </div>
  <div class="card">
    <h2>Recent claims</h2>
    <table><thead><tr><th>#</th><th>Patient</th><th>DOS</th><th>CPT</th><th>Billed</th><th>Paid</th><th>Status</th><th>Risk</th></tr></thead>
    <tbody>${portal.claims.map((c) => `<tr>
      <td><strong>#${c.id}</strong></td><td>${esc(c.patient_initials)}</td><td>${esc(c.date_of_service)}</td>
      <td>${esc(c.cpt_code)}</td><td>${money(c.billed_amount)}</td><td>${money(c.paid_amount)}</td>
      <td>${pillFor(c.status)}</td><td>${c.risk_score !== null && c.risk_score !== undefined ? `<strong>${c.risk_score}</strong>` : '<span class="muted">—</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="8">No claims yet.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <h2>Accounts receivable — oldest first</h2>
    <table><thead><tr><th>#</th><th>Patient</th><th>DOS</th><th>CPT</th><th>Balance</th><th>Age</th></tr></thead>
    <tbody>${portal.ar.map((c) => `<tr>
      <td><strong>#${c.id}</strong></td><td>${esc(c.patient_initials)}</td><td>${esc(c.date_of_service)}</td>
      <td>${esc(c.cpt_code)}</td><td>${money(c.balance)}</td><td>${c.age_days} days</td>
    </tr>`).join('') || '<tr><td colspan="6">Nothing outstanding.</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <h2>Alerts</h2>
    ${portal.alerts.authExpiries.length === 0 && portal.alerts.appealDeadlines.length === 0
      ? '<p>Nothing expiring soon.</p>'
      : `${portal.alerts.authExpiries.map((x) => `<p>⚠ Authorization ${esc(x.auth_number)} (${esc(x.patient_initials)}) ends in <strong>${x.days_left} days</strong>.</p>`).join('')}
         ${portal.alerts.appealDeadlines.map((x) => `<p>⚠ Denial on claim #${x.claim_id} — appeal deadline in <strong>${x.days_left} days</strong> (${esc(x.appeal_deadline)}).</p>`).join('')}`}
  </div>`;
}

const TAB_RENDER = {
  dashboard: renderDashboard, patients: renderPatients, referrals: renderReferrals,
  verifications: renderVerifications, authorizations: renderAuthorizations,
  sessions: renderSessions, claims: renderClaims, denials: renderDenials,
  appeals: renderAppeals,
  calls: renderCalls, era: renderEra, ar: renderAr, import: renderImport,
  audit: renderAudit, settings: renderSettings,
  subscribe: renderSubscribe, automation: renderAutomation, costs: renderCosts,
  integrations: renderIntegrations, portal: renderPortal,
};

/** Settings view when no clinic exists yet (first clinic / demo data). */
function renderNoClinicSettings() {
  return `
  <div class="card">
    <h2>No clinic yet</h2>
    <p>Create your first clinic, or load the demo data to look around first.</p>
    <form class="grid" data-form="add-clinic">
      <label>Clinic name<input name="name" required></label>
      <label>City<input name="city"></label>
      <label>State<input name="state"></label>
      <label>Contact email<input name="contact_email" type="email"></label>
      <button class="btn" type="submit">Create clinic</button>
    </form>
  </div>
  <div class="card">
    <h2>Demo data</h2>
    <p>Load a clearly-labelled sample clinic to show the platform working — no real patients. Remove it any time.</p>
    <div class="btnrow">
      <button class="btn" data-action="demo-load">Load demo data</button>
      <button class="btn danger" data-action="demo-remove">Remove demo data</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------ form handling

function formData(form) {
  const data = {};
  for (const el of new FormData(form).entries()) data[el[0]] = el[1];
  // Unchecked checkboxes must read as false.
  for (const cb of form.querySelectorAll('input[type="checkbox"]')) data[cb.name] = cb.checked;
  return data;
}

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!form.dataset || !form.dataset.form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  try {
    const data = formData(form);
    if (kind === 'setup') {
      await post('/api/auth/register', data);
      const me = await get('/api/auth/me');
      state.user = me.user;
      toast('Owner account created — welcome.');
      return showApp();
    }
    if (kind === 'login') {
      const r = await post('/api/auth/login', data);
      state.user = r.user;
      toast('Signed in.');
      return showApp();
    }
    if (kind === 'add-patient') {
      await post(`/api/clinics/${cid()}/patients`, data);
      toast('Patient added.');
    } else if (kind === 'add-referral') {
      await post(`/api/clinics/${cid()}/referrals`, data);
      toast('Referral added.');
    } else if (kind === 'add-verification') {
      await post(`/api/clinics/${cid()}/verifications`, { ...data, patient_id: Number(data.patient_id) });
      toast('Verification added.');
    } else if (kind === 'add-authorization') {
      await post(`/api/clinics/${cid()}/authorizations`, { ...data, patient_id: Number(data.patient_id) });
      toast('Authorization added.');
    } else if (kind === 'add-session') {
      await post(`/api/clinics/${cid()}/sessions`, {
        ...data, patient_id: Number(data.patient_id),
        authorization_id: data.authorization_id ? Number(data.authorization_id) : undefined,
      });
      toast('Session added.');
    } else if (kind === 'add-claim') {
      await post(`/api/clinics/${cid()}/claims`, {
        ...data, patient_id: Number(data.patient_id),
        authorization_id: data.authorization_id ? Number(data.authorization_id) : undefined,
      });
      toast('Claim added — run the scrubber before submitting.');
    } else if (kind === 'add-denial') {
      await post(`/api/clinics/${cid()}/denials`, { ...data, claim_id: Number(data.claim_id) });
      toast('Denial recorded.');
    } else if (kind === 'add-queue') {
      await post(`/api/clinics/${cid()}/call-queue`, { ...data, claim_id: Number(data.claim_id) });
      toast('Call queued.');
    } else if (kind === 'log-call') {
      const r = await post(`/api/clinics/${cid()}/payer-calls`, { ...data, claim_id: Number(data.claim_id) });
      toast(`Call logged — claim is now ${r.claim.status}. (Simulation mode)`);
    } else if (kind === 'clinic-flags') {
      const r = await patch(`/api/clinics/${cid()}`, data);
      state.clinics = state.clinics.map((c) => (c.id === r.clinic.id ? r.clinic : c));
      toast('Settings saved.');
    } else if (kind === 'add-user') {
      await post('/api/auth/register', { ...data, clinic_id: cid() });
      toast('User added.');
    } else if (kind === 'add-clinic') {
      const r = await post('/api/clinics', data);
      state.clinics.push(r.clinic);
      $('#clinicSelect').innerHTML = state.clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      toast('Clinic created.');
    } else if (kind === 'appeal-generate') {
      const r = await post(`/api/clinics/${cid()}/denials/${data.denial_id}/appeal-draft`, {});
      state.selectedAppeal = r.draft.id;
      toast(`Appeal draft generated (${r.templateLabel}). Edit it before filing.`);
    } else if (kind === 'edit-appeal') {
      await patch(`/api/clinics/${cid()}/appeal-drafts/${data.draft_id}`, { draft_text: data.draft_text, status: data.status });
      state.selectedAppeal = null;
      toast('Appeal draft saved.');
    } else if (kind === 'import-calls') {
      const file = form.querySelector('input[type="file"]').files[0];
      const rows = parseCsv(await readFileAsText(file));
      const r = await post(`/api/clinics/${cid()}/call-queue/import-results`, { results: rows });
      const box = $('#importResults');
      if (box) {
        box.innerHTML = `<p><strong>Import results:</strong> ${r.summary.processed} applied, ${r.summary.failed} failed.</p>`
          + (r.failed.length ? `<ul class="errlist">${r.failed.map((f) => `<li>Row ${f.row}: ${esc(f.error)}</li>`).join('')}</ul>` : '')
          + (r.processed.length ? `<p>${r.processed.map((p) => `Claim #${p.claimId} → ${esc(p.outcome)} (now ${esc(p.claimStatus)})`).join('<br>')}</p>` : '');
      }
      toast(`Call results imported: ${r.summary.processed} applied, ${r.summary.failed} failed.`);
    } else if (kind === 'edi-status-check') {
      const r = await post(`/api/clinics/${cid()}/claims/${data.claim_id}/status-check`, {});
      const box = $('#ediResult');
      if (box) {
        box.innerHTML = `<p><strong>276/277 check:</strong> ${esc(r.answer.message)}<br><span class="muted">276 ref ${esc(r.edi276Ref)} · 277 ref ${esc(r.edi277Ref)} · Simulation mode</span></p>`;
      }
      toast(r.answer.message);
    } else if (kind === 'era-import') {
      const file = form.querySelector('input[type="file"]').files[0];
      const rows = parseCsv(await readFileAsText(file));
      const r = await post(`/api/clinics/${cid()}/era/import`, { rows });
      $('#eraPreview').innerHTML = `<p><strong>Imported ${r.summary.total} ERA line(s):</strong> ${r.summary.matched} matched, ${r.summary.unmatched} unmatched.</p>`;
      toast(`ERA imported: ${r.summary.matched} matched, ${r.summary.unmatched} unmatched.`);
    } else if (kind === 'csv-import') {
      const file = form.querySelector('input[type="file"]').files[0];
      const rows = parseCsv(await readFileAsText(file));
      const type = data.type;
      const prev = await post(`/api/clinics/${cid()}/import/${type}/preview`, { rows });
      const box = $('#csvPreview');
      box.innerHTML = `
        <p><strong>Preview:</strong> ${prev.summary.ready} ready, ${prev.summary.needsFixing} need fixing, ${prev.summary.duplicates} duplicates.</p>
        <table><thead><tr><th>Row</th><th>Status</th><th>Issues</th></tr></thead>
        <tbody>${prev.preview.map((v, i) => `<tr><td>${i + 1}</td><td>${pillFor(v.status === 'ready' ? 'passed' : v.status === 'duplicate' ? 'pending' : 'failed')}</td><td>${esc(v.errors.join('; '))}</td></tr>`).join('')}</tbody></table>
        ${prev.summary.ready > 0 ? `<div class="btnrow"><button class="btn" id="csvDoImport">Import ${prev.summary.ready} ready row(s)</button></div>` : ''}`;
      const btn = $('#csvDoImport');
      if (btn) {
        btn.onclick = async () => {
          try {
            const r2 = await post(`/api/clinics/${cid()}/import/${type}`, { rows });
            toast(`Imported: ${r2.inserted} inserted, ${r2.skipped} skipped, ${r2.failed.length} failed.`);
            state.cache = {};
            renderTab();
          } catch (err2) { toast(err2.message, true); }
        };
      }
      return; // preview only; do not re-render yet
    }
    state.cache = {};
    renderTab();
  } catch (err) {
    toast(err.message, true);
  }
});

// ------------------------------------------------------------ click actions

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    state.cache = {};
    renderTab();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  try {
    if (action === 'delete-patient') {
      if (!confirm('Delete this patient? Their referrals are unlinked and closed.')) return;
      await del(`/api/clinics/${cid()}/patients/${id}`);
      toast('Patient deleted.');
    } else if (action === 'discharge-patient') {
      await patch(`/api/clinics/${cid()}/patients/${id}`, { status: 'discharged' });
      toast('Patient discharged.');
    } else if (action === 'delete-referral') {
      if (!confirm('Delete this referral?')) return;
      await del(`/api/clinics/${cid()}/referrals/${id}`);
      toast('Referral deleted.');
    } else if (action === 'convert-referral') {
      const payer = prompt('Payer for the new patient (optional):', '') || undefined;
      const memberId = prompt('Member ID for the new patient (optional):', '') || undefined;
      const r = await post(`/api/clinics/${cid()}/referrals/${id}/convert`, { payer, member_id: memberId });
      toast(`Referral converted — patient ${r.patient.initials} created.`);
    } else if (action === 'use-units') {
      const n = prompt('How many units were used?', '1');
      if (n === null) return;
      const used = Number(btn.dataset.used || 0) + Number(n);
      if (!Number.isFinite(used) || used < 0) { toast('Enter a valid number of units.', true); return; }
      await patch(`/api/clinics/${cid()}/authorizations/${id}`, { units_used: used });
      toast('Units updated.');
    } else if (action === 'delete-auth') {
      if (!confirm('Delete this authorization? Its sessions are unlinked and kept.')) return;
      const r = await del(`/api/clinics/${cid()}/authorizations/${id}`);
      toast(`Authorization deleted (${r.sessionsUnlinked || 0} session(s) unlinked).`);
    } else if (action === 'delete-session') {
      if (!confirm('Delete this session?')) return;
      await del(`/api/clinics/${cid()}/sessions/${id}`);
      toast('Session deleted.');
    } else if (action === 'session-to-claim') {
      const r = await post(`/api/clinics/${cid()}/sessions/${id}/create-claim`, {});
      toast(`Draft claim #${r.claim.id} created — add the billed amount, then scrub.`);
    } else if (action === 'scrub-claim') {
      const r = await post(`/api/clinics/${cid()}/claims/${id}/scrub`, {});
      toast(r.scrub.passed ? 'Scrub passed — claim is ready to submit.' : `Scrub failed: ${r.scrub.errors.filter((x) => x.severity === 'error').map((x) => x.message).join(' ')}`, !r.scrub.passed);
    } else if (action === 'score-claim') {
      const r = await post(`/api/clinics/${cid()}/claims/${id}/risk`, {});
      toast(`Denial risk ${r.risk.score}/100 (${r.risk.band}) — ${r.risk.factors.length} factor(s).`, r.risk.band === 'high');
    } else if (action === 'edi-status-check') {
      const r = await post(`/api/clinics/${cid()}/claims/${id}/status-check`, {});
      toast(`${r.answer.message} (277 ref ${r.edi277Ref}, simulation)`);
    } else if (action === 'appeal-edit') {
      state.selectedAppeal = Number(id);
    } else if (action === 'appeal-edit-cancel') {
      state.selectedAppeal = null;
    } else if (action === 'appeal-file') {
      const r = await post(`/api/clinics/${cid()}/appeal-drafts/${id}/file`, {});
      toast(`Appeal filed — denial is now ${r.denialStatus}.`);
    } else if (action === 'appeal-delete') {
      if (!confirm('Delete this appeal draft? The denial itself is kept.')) return;
      await del(`/api/clinics/${cid()}/appeal-drafts/${id}`);
      toast('Appeal draft deleted.');
    } else if (action === 'conn-mode') {
      const r = await post(`/api/integrations/${id}/mode`, { mode: btn.dataset.mode });
      toast(`${r.vendor}: mode is now ${r.mode}.`);
    } else if (action === 'submit-claim') {
      const r = await post(`/api/clinics/${cid()}/claims/${id}/submit`, {});
      toast(`Submitted (simulation) — batch ${r.claim.clearinghouse_batch_ref}, payer claim ${r.claim.payer_claim_number}.`);
    } else if (action === 'duplicate-claim') {
      const r = await post(`/api/clinics/${cid()}/claims/${id}/duplicate`, {});
      toast(`Claim duplicated as draft #${r.claim.id}.`);
    } else if (action === 'record-payment') {
      const amt = prompt('Payment amount ($):', '');
      if (amt === null) return;
      await post(`/api/clinics/${cid()}/claims/${id}/record-payment`, { amount: Number(amt) });
      toast('Payment recorded.');
    } else if (action === 'delete-claim') {
      if (!confirm('Delete this claim? Any linked session is unlinked and can be billed again.')) return;
      const r = await del(`/api/clinics/${cid()}/claims/${id}`);
      toast('Claim deleted. ' + (r.note || ''));
    } else if (action === 'cancel-queue') {
      await post(`/api/clinics/${cid()}/call-queue/${id}/cancel`, {});
      toast('Queue item cancelled.');
    } else if (action === 'goto-subscribe') {
      state.tab = 'subscribe';
      renderTab();
    } else if (action === 'sub-trial') {
      const r = await post(`/api/clinics/${cid()}/subscription/trial`, {});
      toast(`Trial started — ends ${r.subscription.trialEndsAt}. No card required.`);
    } else if (action === 'sub-activate') {
      await post(`/api/clinics/${cid()}/subscription/activate`, {});
      toast('Subscription active — $500/month, month-to-month.');
    } else if (action === 'sub-pause') {
      await post(`/api/clinics/${cid()}/subscription/pause`, {});
      toast('Subscription paused — resume any time.');
    } else if (action === 'sub-resume') {
      await post(`/api/clinics/${cid()}/subscription/resume`, {});
      toast('Subscription resumed.');
    } else if (action === 'sub-cancel') {
      if (!confirm('Cancel this subscription? The clinic can re-subscribe any time.')) return;
      await post(`/api/clinics/${cid()}/subscription/cancel`, {});
      toast('Subscription cancelled.');
    } else if (action === 'run-daily') {
      const r = await post('/api/automation/run-daily', {});
      const ran = Object.values(r.sweep.rules).filter((x) => x.ran).length;
      toast(`Daily sweep finished — ${ran} rule(s) ran.`);
    } else if (action === 'send-digest') {
      const r = await post(`/api/clinics/${cid()}/alerts/send-digest`, {});
      toast(r.sent ? `Digest sent (${r.items} item(s)).` : r.note, !!(r.digest && r.digest.status === 'failed'));
    } else if (action === 'toggle-optin') {
      const c = clinic();
      const r = await patch(`/api/clinics/${cid()}`, { payer_calls_opt_in: !c.payer_calls_opt_in });
      state.clinics = state.clinics.map((x) => (x.id === r.clinic.id ? r.clinic : x));
      toast(r.clinic.payer_calls_opt_in ? 'Payer calls are now ON for this clinic.' : 'Payer calls are now OFF for this clinic.');
    } else if (action === 'match-era') {
      await loadCache();
      const claimId = prompt('Match this ERA line to which claim ID?\n' + (state.cache.claims || []).map((c) => `#${c.id} ${c.cpt_code} ${c.date_of_service} ${money(c.billed_amount)} (${c.status})`).join('\n'));
      if (!claimId) return;
      await post(`/api/clinics/${cid()}/era/${id}/match`, { claim_id: Number(claimId) });
      toast('ERA line matched.');
    } else if (action === 'post-era') {
      const r = await post(`/api/clinics/${cid()}/era/${id}/post`, {});
      toast(`Payment posted — claim is now ${r.claimStatus}.`);
    } else if (action === 'delete-user') {
      if (!confirm('Remove this user from the clinic?')) return;
      await del(`/api/clinics/${cid()}/users/${id}`);
      toast('User removed.');
    } else if (action === 'demo-load') {
      const r = await post('/api/demo/load', {});
      toast('Demo data loaded — see the new "Demo Clinic — SAMPLE DATA" in the clinic picker.');
      state.clinics.push({ id: r.demo.clinicId, name: r.demo.name, is_demo: true });
      $('#clinicSelect').innerHTML = state.clinics.map((c) => `<option value="${c.id}">${esc(c.name)}${c.is_demo ? ' (SAMPLE DATA)' : ''}</option>`).join('');
    } else if (action === 'demo-remove') {
      if (!confirm('Remove ALL demo data?')) return;
      const r = await post('/api/demo/remove', {});
      toast(`Demo data removed (${r.removed} clinic(s)).`);
      const { clinics } = await get('/api/clinics');
      state.clinics = clinics;
      $('#clinicSelect').innerHTML = clinics.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      state.clinicId = clinics[0] ? clinics[0].id : null;
      if (state.clinicId) $('#clinicSelect').value = String(state.clinicId);
    }
    state.cache = {};
    renderTab();
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'claimFilter') {
    state.claimFilter = e.target.value;
    renderTab();
    return;
  }
  if (e.target.dataset && e.target.dataset.rule) {
    try {
      await patch(`/api/automation/rules/${e.target.dataset.rule}`, { enabled: e.target.checked });
      toast(`Automation rule ${e.target.checked ? 'on' : 'off'}.`);
    } catch (err) {
      toast(err.message, true);
      renderTab();
    }
    return;
  }
  if (e.target.dataset && e.target.dataset.action === 'denial-status') {
    try {
      await patch(`/api/clinics/${cid()}/denials/${e.target.dataset.id}`, { status: e.target.value });
      toast('Denial status updated.');
    } catch (err) {
      toast(err.message, true);
      renderTab();
    }
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await post('/api/auth/logout', {});
  state.user = null;
  state.clinics = [];
  state.clinicId = null;
  $('#appView').classList.add('hidden');
  $('#whoBox').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
  $('#clinicPicker').classList.add('hidden');
  showLogin();
});

boot();
