'use strict';

/**
 * Vendor integrations (Pass 4) — CentralReach, Rethink BH, Catalyst,
 * Availity, Office Ally, Waystar, Twilio.
 *
 * Every vendor starts in Simulation mode. There is NO live connection
 * until the real vendor account, credentials and approvals exist —
 * `setConnectionMode('live')` is REFUSED, always, with a plain-language
 * message (never a fake live status). The steps listed for each vendor
 * are the exact authorization steps the clinic must complete before
 * a live connection is even possible.
 *
 * EDI is the real route for payers (270/271 eligibility, 276/277 claim
 * status, 837 claim submission, 835 ERA) via a clearinghouse — payer
 * portals have no open APIs, and portal scraping is never used.
 */

const { ApiError } = require('./util');
const { audit } = require('./audit');

const VENDORS = {
  centralreach: {
    label: 'CentralReach',
    kind: 'Practice management / EHR',
    what: 'Scheduling, session notes and billing for ABA clinics. The platform reads sessions and authorizations from CentralReach instead of re-typing them.',
    edi: 'No EDI — API only.',
    steps: [
      'The clinic asks its CentralReach account admin to approve API access (partner API) for Zenvy Digitals.',
      'CentralReach issues an API key for the clinic — the key is stored only on the Zenvy server, never in the browser.',
      'The clinic signs a data-use authorization naming Zenvy Digitals as its billing vendor (covered by the BAA).',
      'Zenvy tests the connection in Simulation mode first, then the clinic confirms its own sessions appear correctly.',
    ],
  },
  rethink: {
    label: 'Rethink BH',
    kind: 'Practice management / EHR',
    what: 'Scheduling, data collection and billing for ABA clinics. Same role as CentralReach: sessions and authorizations flow in automatically.',
    edi: 'No EDI — API only.',
    steps: [
      'The clinic asks Rethink BH support to enable API / integration access for Zenvy Digitals.',
      'Rethink BH issues API credentials for the clinic — stored only on the Zenvy server.',
      'The clinic signs a data-use authorization naming Zenvy Digitals as its billing vendor (covered by the BAA).',
      'Zenvy tests the connection in Simulation mode first, then the clinic confirms its own data appears correctly.',
    ],
  },
  catalyst: {
    label: 'Catalyst',
    kind: 'Data collection / practice software',
    what: 'Session data and authorizations for ABA clinics. Sessions recorded in Catalyst flow into claims here.',
    edi: 'No EDI — API only.',
    steps: [
      'The clinic asks Catalyst support to enable API access for Zenvy Digitals.',
      'Catalyst issues an API key for the clinic — stored only on the Zenvy server.',
      'The clinic signs a data-use authorization naming Zenvy Digitals as its billing vendor (covered by the BAA).',
      'Zenvy tests the connection in Simulation mode first, then the clinic confirms its own sessions appear correctly.',
    ],
  },
  availity: {
    label: 'Availity',
    kind: 'Clearinghouse / payer portal network',
    what: 'Eligibility checks (270/271), claim status (276/277) and ERA (835) for many payers through one connection.',
    edi: '270/271 eligibility · 276/277 claim status · 835 ERA.',
    steps: [
      'The clinic enrolls with Availity (Availity Essentials) and completes Availity’s trading-partner agreement.',
      'The clinic enables 270/271 eligibility, 276/277 claim status and 835 ERA for each payer it bills.',
      'Availity approves the enrollment — this takes days to weeks per payer, and Availity may ask for the clinic’s NPI and tax ID.',
      'The clinic gives Zenvy Digitals its Availity organization ID so claims can be routed under the clinic, not under Zenvy.',
    ],
  },
  office_ally: {
    label: 'Office Ally',
    kind: 'Clearinghouse',
    what: 'Claim submission (837) and ERA (835). The route most small ABA clinics already use to send claims.',
    edi: '837 claim submission · 835 ERA.',
    steps: [
      'The clinic enrolls with Office Ally as a clearinghouse (free enrollment for most payers).',
      'The clinic completes payer enrollment for each payer it bills — Office Ally confirms each payer one by one.',
      'The clinic gives Zenvy Digitals its Office Ally sender ID so 837 files go out under the clinic.',
      'Zenvy tests with one real claim in Simulation mode first, then switches that payer to live only after the payer confirms receipt.',
    ],
  },
  waystar: {
    label: 'Waystar',
    kind: 'Clearinghouse / revenue cycle',
    what: 'Claim submission (837), claim status and ERA (835) for clinics that already bill through Waystar.',
    edi: '837 claim submission · 276/277 claim status · 835 ERA.',
    steps: [
      'The clinic enrolls with Waystar and completes its payer enrollments.',
      'The clinic authorizes Zenvy Digitals as a submitter on its Waystar account.',
      'Waystar approves the submitter — this takes days to weeks per payer.',
      'Zenvy tests with one real claim in Simulation mode first, then switches that payer to live only after Waystar confirms receipt.',
    ],
  },
  twilio: {
    label: 'Twilio',
    kind: 'Phone — Sara payer calls',
    what: 'The phone line Sara calls payers on. Live calling needs a Twilio account, a US number and an approved business profile.',
    edi: 'No EDI — voice only.',
    steps: [
      'Zenvy creates a Twilio account and verifies a US phone number for the platform.',
      'Twilio approves the Business Primary Customer Profile (required for accounts created outside the US/Canada before +1 numbers can be called).',
      'The Twilio Account SID, Auth Token and number are stored only on the server (.env) — never in the website or the app code.',
      'Payer calls stay opt-in per clinic: a clinic that has not enabled payer calls is never called, live or simulated.',
    ],
  },
};

const VENDOR_ORDER = ['centralreach', 'rethink', 'catalyst', 'availity', 'office_ally', 'waystar', 'twilio'];

/**
 * Change a vendor's connection mode. 'off' and 'simulation' are allowed
 * (Zenvy owner only, enforced in the route). 'live' is REFUSED — always —
 * until the real vendor account, credentials and approvals exist. The
 * refusal is recorded in the audit log so nobody can claim it was tried
 * silently.
 */
async function setConnectionMode(q, vendor, mode, actor) {
  if (!VENDORS[vendor]) throw new ApiError(404, `Unknown vendor: ${vendor}.`);
  if (!['off', 'simulation', 'live'].includes(mode)) {
    throw new ApiError(400, "Mode must be off, simulation or live.");
  }
  if (mode === 'live') {
    await audit(q, {
      actor, clinicId: null, entity: 'connection', entityId: null, action: 'connection-live-refused',
      detail: { vendor },
    });
    throw new ApiError(
      409,
      `${VENDORS[vendor].label} cannot be switched to Live yet — the real vendor account, credentials and approvals are not in place. Complete the authorization steps listed for ${VENDORS[vendor].label} first; until then the connection stays in Simulation mode and no live data is sent or received.`
    );
  }
  const { rows } = await q(
    'UPDATE connections SET mode = $1, updated_at = now() WHERE vendor = $2 RETURNING *',
    [mode, vendor]
  );
  await audit(q, {
    actor, clinicId: null, entity: 'connection', entityId: rows[0].id, action: 'update',
    detail: { vendor, mode },
  });
  return rows[0];
}

module.exports = { VENDORS, VENDOR_ORDER, setConnectionMode };
