'use strict';

/**
 * Resend email sender (Pass 3: alert digests).
 *
 * RESEND_API_KEY comes from the environment ONLY. When it is not set (or
 * Resend rejects the send), delivery is reported as FAILED with the
 * reason — never assumed. The digest pipeline records that status on
 * the alert_emails row, so a clinic can always see what actually went
 * out and what did not.
 */

const FROM = 'Zenvy Digitals <billing@zenvydigitals.online>';

/**
 * Send one email through Resend.
 * Returns { delivered: true, id } or { delivered: false, error }.
 * Never throws for a missing key or a network failure — the caller
 * records the failure honestly.
 */
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { delivered: false, error: 'Resend API key is not configured — email not sent.' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { delivered: false, error: `Resend rejected the email (${r.status}): ${j.message || 'no detail given'}` };
    }
    return { delivered: true, id: j.id || null };
  } catch (err) {
    return { delivered: false, error: `Could not reach Resend: ${err.message}` };
  }
}

module.exports = { sendEmail, FROM };
