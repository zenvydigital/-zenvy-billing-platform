'use strict';

/**
 * Auto-appeal draft generator (Pass 4).
 *
 * Payer-specific templates, with a generic fallback for any payer /
 * denial code. Every known fact (clinic, patient initials, claim,
 * authorization, denial) is filled in; only things the platform does
 * not know (provider NPI, contact name) are left as [bracketed]
 * placeholders for the biller to fill before filing.
 *
 * A generated draft is a starting point, not a legal letter — the
 * biller edits it, marks it ready, and only then marks it filed.
 * Marking filed moves the denial to 'appealing'. Deleting a draft
 * never deletes the denial.
 */

function payerKey(payer) {
  return String(payer || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function codeKey(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Template key, e.g. 'aetna-co-97' — falls back to 'generic'. */
function templateKeyFor(payer, denialCode) {
  const key = `${payerKey(payer)}-${codeKey(denialCode)}`;
  return TEMPLATES[key] ? key : 'generic';
}

function headerBlock(ctx) {
  return [
    `${ctx.clinicName}`,
    ctx.clinicCity ? `${ctx.clinicCity}, ${ctx.clinicState || ''}`.trim() : '',
    ctx.clinicEmail ? `Contact: ${ctx.clinicEmail}` : '',
    '',
    `Date: ${ctx.today}`,
    '',
    `Re: Appeal of denied claim — Claim #${ctx.claimId}`,
    `Patient: ${ctx.patientInitials} | Date of service: ${ctx.dateOfService} | CPT: ${ctx.cptCode} (${ctx.units} unit(s)) | Billed: $${ctx.billedAmount}`,
    `Payer: ${ctx.payer} | Denial code: ${ctx.denialCode}${ctx.denialReason ? ` — ${ctx.denialReason}` : ''}`,
    ctx.authNumber ? `Authorization: ${ctx.authNumber}` : '',
    '',
  ].filter((l) => l !== undefined).join('\n');
}

const TEMPLATES = {
  'aetna-co97': {
    label: 'Aetna — CO-97 (bundled / included in another payment)',
    build(ctx) {
      return `${headerBlock(ctx)}Dear Aetna Appeals Department,

We are appealing the denial of the above claim (denial code CO-97 — "the benefit for this service is included in the payment for another service already adjudicated").

CPT ${ctx.cptCode} on ${ctx.dateOfService} is a distinct, separately billable ABA service. It was delivered in its own timed session under authorization ${ctx.authNumber || '[authorization number]'}, it is not a component of any other service billed that day, and no other claim covers it. The service was medically necessary, it was delivered as documented in the session note, and it falls inside the authorization dates and unit limits.

Please reprocess this claim as a separate payable service and release the ${ctx.billedAmount} billed amount. If you need the session note or the authorization letter, we will send them on request.

Thank you for your review.

Sincerely,
[Your name], ${ctx.clinicName}
[Phone] | [Email]`;
    },
  },

  generic: {
    label: 'Generic appeal letter (any payer / denial code)',
    build(ctx) {
      return `${headerBlock(ctx)}Dear Appeals Department,

We are appealing the denial of the above claim (denial code ${ctx.denialCode || '[code]'}${ctx.denialReason ? ` — ${ctx.denialReason}` : ''}).

The service billed (CPT ${ctx.cptCode}, ${ctx.units} unit(s), date of service ${ctx.dateOfService}) was medically necessary, was delivered as documented, and was covered by authorization ${ctx.authNumber || '[authorization number]'} at the time of service. We believe the denial was issued in error and ask that you reprocess the claim and release the $${ctx.billedAmount} billed amount.

Please let us know if you need the session note, the authorization letter, or any other supporting document.

Thank you for your review.

Sincerely,
[Your name], ${ctx.clinicName}
[Phone] | [Email]`;
    },
  },
};

/** Build a draft for a denial. ctx carries every known fact. Returns { template, draftText }. */
function buildAppealDraft(ctx) {
  const template = templateKeyFor(ctx.payer, ctx.denialCode);
  const tpl = TEMPLATES[template];
  return { template, label: tpl.label, draftText: tpl.build(ctx) };
}

module.exports = { buildAppealDraft, templateKeyFor, TEMPLATES };
