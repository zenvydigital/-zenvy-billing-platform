'use strict';

/**
 * Trial signup emails (Pass 5 follow-up #2) — sent best-effort AFTER a
 * public trial signup commits, through the same Resend helper the Pass 3
 * alert digests use (src/resend.js: same sender
 * billing@zenvydigitals.online, same "never throws" contract — a missing
 * key or a failed send returns { delivered: false, error } instead of
 * throwing).
 *
 *   (a) Welcome email to the clinic's work email: trial started, 7 days,
 *       trial end date, what to do first (Quick-Start checklist, sample
 *       data already loaded), contact billing@zenvydigitals.online.
 *   (b) Notification email to billing@zenvydigitals.online: a new trial
 *       started — clinic name, contact name, work email, time.
 *
 * sendTrialEmails() NEVER throws and NEVER fails the signup: each send is
 * raced against an 8-second timeout so a hung Resend cannot stall the
 * response, and every outcome is logged honestly (sent vs failed +
 * reason). The caller reports the real outcome — never an invented
 * "sent" status. Emails only send when RESEND_API_KEY is set in the
 * environment (Vercel dashboard in production); without it the signup
 * still returns 201 and the log says the key is missing.
 */

const { sendEmail } = require('./resend');

const NOTIFY_TO = 'billing@zenvydigitals.online';
const SEND_TIMEOUT_MS = 8000;

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function welcomeHtml({ clinicName, name, trialEndsAt, sampleDataLoaded }) {
  const sampleLine = sampleDataLoaded
    ? '<li><strong>Sample data is already loaded</strong> in your clinic — 3 sample patients, 4 claims (one clean, one the scrubber catches, one paid, one denied), an open denial and AR to explore. It is clearly marked SAMPLE DATA and you can remove it in one click from the dashboard checklist.</li>'
    : '<li>Your clinic starts empty — load the one-click sample data from the dashboard checklist to see the platform working before you add real data.</li>';
  return `<p>Hello ${esc(name)},</p>
<p>Welcome to Zenvy Digitals — your free trial for <strong>${esc(clinicName)}</strong> has started.</p>
<ul>
<li><strong>7-day free trial</strong> — no card required. Your trial ends on <strong>${esc(trialEndsAt)}</strong>.</li>
<li>After the trial: <strong>$500/month per clinic</strong>, month-to-month, cancel any time.</li>
${sampleLine}
<li><strong>What to do first:</strong> follow the Quick-Start checklist on your dashboard — record your BAA, add your first patient (initials only), add an authorization, create a claim, and watch the scrubber catch mistakes before a payer does.</li>
<li><strong>Real patient data stays blocked until your BAA is signed</strong> — record it from Settings when you are ready.</li>
</ul>
<p>Questions? Reply to this email or write to ${NOTIFY_TO} — the Zenvy team helps with onboarding and data import, free.</p>
<p>— Zenvy Digitals · ABA Billing, Handled Properly</p>`;
}

function notifyHtml({ clinicName, name, email, trialEndsAt, startedAt, sampleDataLoaded }) {
  return `<p>A new free trial started on the Zenvy Billing Platform.</p>
<ul>
<li><strong>Clinic:</strong> ${esc(clinicName)}</li>
<li><strong>Contact:</strong> ${esc(name)} (${esc(email)})</li>
<li><strong>Started:</strong> ${esc(startedAt)}</li>
<li><strong>Trial ends:</strong> ${esc(trialEndsAt)} (7 days)</li>
<li><strong>Sample data:</strong> ${sampleDataLoaded ? 'loaded' : 'NOT loaded (load failed — see server log)'}</li>
</ul>
<p>Plan: platform-500 ($500/month after the trial). No card on file.</p>`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ delivered: false, error: `${label} timed out after ${ms}ms` }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Send both trial emails. Returns { welcome, notify } with each entry
 * the sendEmail outcome ({ delivered, id } or { delivered: false,
 * error }). Never throws.
 */
async function sendTrialEmails({ clinic, user, trialEndsAt, sampleDataLoaded }) {
  const startedAt = new Date().toISOString();
  const jobs = [
    ['welcome', sendEmail({
      to: user.email,
      subject: `Your Zenvy trial started — ${clinic.name} (7 days free)`,
      html: welcomeHtml({ clinicName: clinic.name, name: user.name, trialEndsAt, sampleDataLoaded }),
    })],
    ['notify', sendEmail({
      to: NOTIFY_TO,
      subject: `New trial started — ${clinic.name}`,
      html: notifyHtml({ clinicName: clinic.name, name: user.name, email: user.email, trialEndsAt, startedAt, sampleDataLoaded }),
    })],
  ];
  const outcomes = {};
  await Promise.all(jobs.map(async ([key, p]) => {
    const r = await withTimeout(p, SEND_TIMEOUT_MS, `trial ${key} email`);
    outcomes[key] = r;
    if (r.delivered) console.log(`[trial] ${key} email sent for clinic ${clinic.id} (${r.id || 'no id'})`);
    else console.error(`[trial] ${key} email NOT sent for clinic ${clinic.id}: ${r.error}`);
  }));
  return outcomes;
}

module.exports = { sendTrialEmails, NOTIFY_TO, welcomeHtml, notifyHtml };
