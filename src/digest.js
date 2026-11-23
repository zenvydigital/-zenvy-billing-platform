'use strict';

/**
 * Alert digest pipeline (Pass 3): compose → queue → deliver → record.
 *
 * A digest covers, for one clinic:
 *   - authorizations ending within 30 days (status active or expiring)
 *   - open denials whose appeal deadline falls within 14 days
 * One digest per clinic per day, maximum. Delivery status is recorded
 * honestly on the alert_emails row: 'sent' only after Resend accepts
 * the email, 'failed' with the reason otherwise — never assumed.
 *
 * Used by the manual "send now" endpoint and by the alert_digest
 * automation rule (daily sweep).
 */

const { daysUntil, isoDate, asJson } = require('./util');
const { sendEmail } = require('./resend');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function datePlus(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Build the digest items for a clinic (no sending, no recording). */
async function composeDigest(q, clinic) {
  const auths = await q(
    `SELECT a.*, p.initials AS patient_initials FROM authorizations a
      JOIN patients p ON p.id = a.patient_id
     WHERE a.clinic_id = $1 AND a.status IN ('active', 'expiring')
       AND a.end_date <= $2
     ORDER BY a.end_date ASC`,
    [clinic.id, datePlus(30)]
  );
  const denials = await q(
    `SELECT d.*, c.date_of_service FROM denials d
      JOIN claims c ON c.id = d.claim_id
     WHERE d.clinic_id = $1 AND d.status = 'open'
       AND d.appeal_deadline <= $2
     ORDER BY d.appeal_deadline ASC`,
    [clinic.id, datePlus(14)]
  );
  const items = [];
  for (const a of auths.rows) {
    const left = (a.total_units || 0) - (a.units_used || 0);
    items.push({
      type: 'auth-expiry',
      auth_number: a.auth_number,
      patient_initials: a.patient_initials,
      days_left: daysUntil(a.end_date),
      units_remaining: left,
      end_date: isoDate(a.end_date),
      text: `Authorization ${a.auth_number} (${a.patient_initials}) ends in ${daysUntil(a.end_date)} day(s) — ${left} unit(s) left.`,
    });
  }
  for (const d of denials.rows) {
    items.push({
      type: 'appeal-deadline',
      claim_id: d.claim_id,
      denial_code: d.denial_code,
      days_left: daysUntil(d.appeal_deadline),
      appeal_deadline: isoDate(d.appeal_deadline),
      text: `Denial ${d.denial_code || ''} on claim #${d.claim_id} — appeal deadline in ${daysUntil(d.appeal_deadline)} day(s) (${isoDate(d.appeal_deadline)}).`,
    });
  }
  return items;
}

function digestHtml(clinic, items, digestDate) {
  const lines = items.length === 0
    ? '<li>Nothing expiring soon — no authorizations ending within 30 days and no appeal deadlines within 14 days.</li>'
    : items.map((i) => `<li>${i.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('');
  return `<p>Hello ${clinic.name},</p>
<p>Your daily alert digest from Zenvy Digitals (${digestDate}):</p>
<ul>${lines}</ul>
<p>Authorizations ending within 30 days and appeal deadlines within 14 days are listed here. Manage alert settings in the platform (Settings).</p>
<p>— Zenvy Digitals · ABA Billing, Handled Properly · billing@zenvydigitals.online</p>`;
}

/**
 * Queue today's digest for a clinic and attempt delivery.
 * Returns { digest, sent, items, note }.
 * - Already sent today → returns the existing row, no duplicate.
 * - Failed earlier today → re-attempts delivery with the stored items.
 * - Nothing to report → no row, no email (a digest with no items is noise).
 */
async function queueAndSendDigest(q, clinic) {
  const date = todayStr();
  const existing = await q(
    'SELECT * FROM alert_emails WHERE clinic_id = $1 AND digest_date = $2',
    [clinic.id, date]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.status === 'sent') {
      return { digest: row, sent: false, items: asJson(row.items, []), note: 'Today’s digest was already sent — no duplicate sent.' };
    }
    const items = asJson(row.items, []);
    const attempt = await sendEmail({
      to: clinic.alert_email,
      subject: `Zenvy alert digest — ${clinic.name} (${date})`,
      html: digestHtml(clinic, items, date),
    });
    const upd = await q(
      `UPDATE alert_emails SET status = $1, error = $2, sent_at = $3 WHERE id = $4 RETURNING *`,
      [attempt.delivered ? 'sent' : 'failed', attempt.error || null, attempt.delivered ? new Date().toISOString() : null, row.id]
    );
    return {
      digest: upd.rows[0],
      sent: attempt.delivered,
      items,
      note: attempt.delivered ? 'Digest re-sent.' : `Delivery failed again: ${attempt.error}`,
    };
  }

  const items = await composeDigest(q, clinic);
  if (items.length === 0) {
    return { digest: null, sent: false, items, note: 'Nothing to report today — no digest sent.' };
  }
  const ins = await q(
    `INSERT INTO alert_emails (clinic_id, digest_date, items, status) VALUES ($1, $2, $3, 'queued') RETURNING *`,
    [clinic.id, date, JSON.stringify(items)]
  );
  const attempt = await sendEmail({
    to: clinic.alert_email,
    subject: `Zenvy alert digest — ${clinic.name} (${date})`,
    html: digestHtml(clinic, items, date),
  });
  const upd = await q(
    `UPDATE alert_emails SET status = $1, error = $2, sent_at = $3 WHERE id = $4 RETURNING *`,
    [attempt.delivered ? 'sent' : 'failed', attempt.error || null, attempt.delivered ? new Date().toISOString() : null, ins.rows[0].id]
  );
  return {
    digest: upd.rows[0],
    sent: attempt.delivered,
    items,
    note: attempt.delivered ? 'Digest sent.' : `Digest queued but delivery failed: ${attempt.error}`,
  };
}

module.exports = { composeDigest, queueAndSendDigest, todayStr, datePlus };
