# Zenvy Digitals Billing Platform — Build Plan (standalone rebuild)

**Owner:** Rza / Muhammad Asim Khan — Zenvy Digitals.
**Goal:** own server code for the ABA billing platform, deployable on **Render free tier**
at `app.zenvydigitals.online`, portable later to **DigitalOcean** when revenue starts.
**Status: Pass 4 (final) — integrations, risk score, appeals, Sara bridge, portal, audit hardening built + verified (63 checks pass, 2026-11-23).**
Full app UI is Google-style (clean white, Zenvy navy + gold sparingly —
see design note below). The app is deploy-ready; what remains is Rza's
accounts (GitHub, Render, Supabase, Paddle verification) — see §5 and the
Pass 4 verification log.

This rebuild replaces the Muse fullstack artifact `zenvy-digitals-billing-platform`
(which works and is fully tested, but **cannot be exported or made public** — interactive
apps have no export path). Same features, same Zenvy navy + gold branding, same rules.
The artifact remains the live reference spec: its 69 published actions define the API
surface this rebuild must match.

**Design direction (Rza, 2026-11-23): GOOGLE-STYLE — clean white, simple shapes,
same look as zenvydigitals.online (modelled on about.google/products). Shape, style,
layout — all Google-like. BUT the logo is OURS: Zenvy Digitals logo (navy + gold 'Z'
monogram) — NEVER Google's "G" logo or any Google trademark. So: Google-style design
language + Zenvy branding. In practice: white header and page, light #dadce0 borders,
8px corners, soft shadows, text tabs with a gold underline for the active tab, navy
primary buttons, near-black #202124 text, gray #5f6368 secondary text. Navy + gold
used sparingly — logo wordmark and key accents only (see `public/style.css`).**

---

## 1. Architecture

```
Clinics (browser)
    │  HTTPS
    ▼
Render free web service  (Node.js + Express, one service, sleeps after 15 min idle)
    │  DATABASE_URL (env only)
    ▼
Supabase Free — managed Postgres (500 MB, no expiry, no card)
    │
    ├─ Paddle (subscriptions, $500/mo) — webhook → setsubscription
    ├─ Resend (alert digest emails) — sendduealertdigests
    └─ Twilio + Deepgram + Gemini (Sara payer calls) — Phase 2, opt-in only
```

- **One web service, one database.** No microservices, no vendor-specific code.
- **All config in env vars** (see `.env.example`). No secrets in code, no hardcoded
  hosts — the app only knows `PORT`, `DATABASE_URL`, `JWT_SECRET`, `APP_BASE_URL`.
- **Migrations run at startup** when `DATABASE_URL` is set; a missing DB never blocks
  startup (`/health` reports `db: "not-configured"`).
- **Frontend:** server-rendered pages + small client JS in `public/` (Pass 2+). No SPA
  framework — keeps the free-tier service light and the build simple.
- **Scheduled work** (daily alert digest ~08:30 PKT, automation sweep ~07:45 PKT):
  Render free has no cron jobs, so the sweeps are **HTTP endpoints**
  (`POST /api/internal/run-daily`) triggered by an external scheduler (UptimeRobot /
  cron-job.org free ping, or a later paid Render cron). The endpoints require a
  `CRON_SECRET` header. On DigitalOcean the same endpoints are called by the
  Droplet's own `cron`.

## 2. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20** (LTS) | Same language the team already runs (Sara free build is Node/Python mix; Express is the smallest honest server). `engines: >=20`. |
| Web | **Express 4** | Minimal, boring, well-known. JSON API + static files. |
| Database | **Postgres** via `pg` | The artifact's data model is relational (clinics → patients → auths → sessions → claims → denials → ERA). Plain SQL, no ORM — migrations stay readable and portable. |
| Auth | **Email + password, bcrypt, JWT in httpOnly cookie** | Per-user logins for hosted deployment (the artifact had one workstation profile). Roles: `owner` / `biller` / `viewer`, enforced server-side. |
| Email | **Resend** (already set up, free 3,000/mo) | Alert digests only. Delivery to a real inbox is still unproven — no Resend key in test; digests record 'failed' honestly until then. |
| Payments | **Paddle** (Rza's account, in progress) | Webhook updates `clinics.subscription_status`. Never store card data. |
| AI calls | **Twilio + Deepgram + Gemini** (Sara) | Phase 2. Queue + dialer bridge first; live calling only when Twilio is connected. |
| Hosting (now) | **Render free web service** | $0, no card. Sleeps after 15 min idle (~1 min wake) — acceptable for beta. |
| Hosting (later) | **DigitalOcean Droplet** | Same Docker image, same Postgres (see §7). Move when the first clinic pays. |

### Database decision (verified 2026-11-23)

| Option | Free tier | Verdict |
|---|---|---|
| **Supabase Free — PICKED** | Postgres, **500 MB**, shared CPU, 5 GB egress, **no time limit, no card** | Real Postgres; standard `pg` driver; nothing to migrate when moving hosts — only `DATABASE_URL` changes. |
| Render Postgres free | Expires **30 days** after creation | Rejected — the exact problem we are avoiding (data loss risk). |
| Turso Free | SQLite/libSQL, 5 GB, 500M rows read / 10M rows written / mo, no card | Rejected — **not Postgres** (breaks the stack); free DBs are **archived after 10 days of inactivity**; Turso has announced it is **joining Supabase**, so its future is uncertain. Row-metering also punishes bulk CSV imports. |
| Neon Free (fallback) | Postgres, 1 GB, 100 CU-hours / mo, scales to zero, no card | Good fallback if Supabase pausing ever bites: no pause, but the 100 CU-hour monthly compute cap is a real ceiling as usage grows. |

**Supabase catch, stated honestly:** free projects **pause after 1 week of inactivity**
and must be restored from the dashboard (restorable for up to 1 year). Mitigation is
built in: the daily automation sweep + health check hit the database every day, so a
live beta never goes quiet for a week; if a pause ever happens, restore is one click
and no data is lost. No automatic backups on Free — **weekly manual export**
(`pg_dump` via Supabase dashboard) is a Pass 2 ops task until the move to paid.

Sources: Supabase free limits (bytebase.com/blog/supabase-vs-aws-database-pricing,
fastero.com/blog/free-postgres-database, checked 12 Nov 2026); Turso free limits
(actualdatabase.com/supabase-vs-neon-vs-turso-free-tier-limits, 29 Oct 2026;
stacksfree.com/blog/turso-free-tier-guide-2026).

## 3. Data model

Migrations in `db/migrations/` (all plain Postgres DDL, no extensions, runnable in
pg-mem smoke test). Core tables:

| Table | Key fields | Notes |
|---|---|---|
| `clinics` | name, city, state, timezone, contact_*, status, `baa_signed`, `payer_calls_opt_in`, `alerts_enabled`, `alert_email`, `subscription_status` (none/trial/active/paused/cancelled), `subscription_plan` ('platform-500'), `trial_ends_at`, `is_demo` | One row per clinic. $500/mo. |
| `users` | clinic_id (NULL = Zenvy owner), name, email UNIQUE, password_hash, role (owner/biller/viewer) | Per-user logins. Viewer is read-only, server-enforced. |
| `patients` | clinic_id, `initials` (≤10 chars, **never full names, never DOB**), payer, member_id, status, is_demo | UNIQUE(clinic_id, initials, member_id). Real rows require BAA. |
| `referrals` | clinic_id, patient_id (SET NULL on unlink), referral_initials, source, notes, status (new/contacted/converted/closed) | Convert → patient; delete unlinks/closes, never deletes the patient. |
| `verifications` | clinic_id, patient_id, payer, status (pending/eligible/ineligible), coverage_start/end, notes, edi_270_ref, edi_271_ref | Eligibility. |
| `authorizations` | clinic_id, patient_id, auth_number UNIQUE per clinic, payer, cpt_codes, total_units, units_used, start/end_date, status | 30/14/7-day expiry alerts; unit tracking. |
| `sessions` | clinic_id, patient_id, authorization_id (SET NULL), claim_id (SET NULL — added by ALTER, see below), session_date, cpt_code, units, duration_min, status (scheduled/completed/cancelled/billed) | Completed session → draft claim in one tap. |
| `claims` | clinic_id, patient_id, authorization_id, session_id, date_of_service, cpt_code, units, billed/paid_amount, status (draft/ready/submitted/partial/paid/denied), scrub_status + scrub_errors (JSONB), risk_score + risk_factors (JSONB), clearinghouse_batch_ref, payer_claim_number, edi_276/277_ref, notes | **Scrub gate:** cannot be marked submitted until scrub passes. |
| `denials` | clinic_id, claim_id, patient_id, denial_code (CO-97, CO-197…), reason, status (open/appealing/appealed/written-off), appeal_deadline | Appeal deadline tracking. |
| `payer_calls` | clinic_id, claim_id, queue_id (ALTER), caller (sara/team), outcome, status_answer, reference_number, next_action, is_simulated (default TRUE) | Outcome updates the claim. |
| `payer_call_queue` | clinic_id, claim_id, question (exact question to ask), status (queued/processing/done/cancelled) | Sara's queue. Opt-in clinics only. |
| `appeal_drafts` | denial_id, claim_id, payer, template (e.g. aetna-co97), draft_text, status (draft/ready/filed) | Filed → denial 'appealing'. Draft delete never deletes the denial. |
| `era_lines` | clinic_id, claim_id (NULL while unmatched), payer_claim_number, patient_initials, date_of_service, cpt_code, paid_amount, status (unmatched/matched/posted), raw_ref | **Financial records: no delete path, ever.** |
| `audit_log` | actor_name, actor_role, clinic_id, entity, entity_id, action, detail (JSONB) | **Append-only.** No update/delete API, ever. |
| `automation_rules` | rule_key (eligibility_checks, auth_scan, followup_scan, call_runner, alert_digest), enabled, last_run_at | Seeded: all 5 ON. Owner toggles. |
| `automation_runs` | rule_key, started/finished_at, result (JSONB), error | Run history. |
| `alert_emails` | clinic_id, digest_date, items (JSONB), status (queued/sent/failed), error, sent_at | One digest per clinic per day max. |
| `connections` | vendor (centralreach, rethink, catalyst, availity, office_ally, waystar, twilio), mode (off/simulation/live), notes | Seeded: all **simulation**. Live is refused until the real vendor account + approvals exist. |
| `schema_migrations` | filename, applied_at | Migration bookkeeping. |

**Schema lesson carried over from the artifact (verified by live testing there):**
- **Partial updates MERGE** with stored values — an omitted field is never blanked.
- **Deletes unlink** linked records (claim→session, patient→referral, auth→sessions)
  and show plain-language messages, never raw SQL.
- Two forward foreign keys in `002_billing.sql` (`sessions.claim_id`,
  `payer_calls.queue_id`) are added by `ALTER TABLE` at the end of the file —
  real Postgres rejects forward references; pg-mem lets them slide.

## 4. Feature checklist — build order

**Pass 2 — Core (must-have for beta) — DONE 2026-11-23 (63 checks pass):**
- [x] Auth: register/login/logout, sessions (JWT cookie), roles owner/biller/viewer enforced on every route; viewer writes rejected with a clear message.
- [x] Clinics CRUD + flags (BAA, payer-call opt-in, alerts) — owner-only flag changes.
- [x] Patients CRUD (initials-only validation; **BAA gate**: real patient rejected without BAA, clear error), referrals CRUD + convert-to-patient.
- [x] Verifications + authorizations CRUD; auth expiry scan (30/14/7 days) + units remaining.
- [x] Sessions CRUD + `createclaimfromsession` (completed session → draft claim, one tap).
- [x] Claims CRUD + `duplicateclaim`; scrubber (`scrubclaim`: CPT validity, billed amount, eligibility, auth coverage + units, duplicates) + **submit gate** (failed scrub blocks submit).
- [x] Clearinghouse submit (`submittoclearinghouse`, batch ref + payer claim number; simulation until a live account exists).
- [x] Denials CRUD + appeal deadline tracking; payer calls log + queue (opt-in enforced); call outcome updates claim.
- [x] ERA import + auto-match (payer claim # first, then initials + DOS + CPT) + manual match; posting paid/partial; unmatched stored honestly.
- [x] AR aging + follow-up list (oldest first); reports (weekly + per-clinic); dashboard "Recovered this month" lead number.
- [x] Audit log on every write (actor, role, clinic, entity, action).
- [x] CSV import/export: patients, referrals, authorizations, claims, sessions — templates, validation preview (ready vs needs-fixing per row), inserted/skipped/failed report, duplicate detection; full names/DOB rejected.
- [x] Demo data loader + one-click remove (clearly labelled sample clinic).
- [x] `GET /` app UI (Google-style: clean white, Zenvy navy + gold sparingly — Rza's direction 2026-11-23; NEVER Google's "G" logo) for all of the above; `GET /health`.
- [x] Weekly manual DB export runbook (until paid plan) — in README.md.

**Pass 3 — Subscriptions, alerts, automation — DONE 2026-11-23 (70 checks pass):**
- [x] Subscribe page + lifecycle (`/api/clinics/:id/subscription`): none → trial (14 days, no card) → active $500/mo → paused → resumed → cancelled → re-subscribe; all owner-only, all in the audit log. Paddle mode shown honestly (sandbox / not-configured until keys are set).
- [x] Paddle webhook (`POST /api/paddle/webhook`, raw body, HMAC-SHA256 signature verification): subscription.created/updated/paused/canceled mapped onto the clinic via custom_data.clinic_id; past_due keeps the status; unknown clinics/events acknowledged, never crashed; 503 without a secret, 401 on a bad signature.
- [x] Email alerts: per-clinic on/off + alert address; digest composer (auth ≤30d, appeal deadlines ≤14d); compose → queue → deliver → record; delivery status recorded honestly ('sent' only after Resend accepts, 'failed' with the reason — no key in test = failed, never assumed); one digest per clinic per day max; manual send-now + digest history in Settings.
- [x] Automation rules (5 toggles) + `run-daily` sweep endpoint (`POST /api/internal/run-daily`, CRON_SECRET header; same sweep from the Automation tab): eligibility re-checks (simulation, SIM-271 refs), auth expiry scan, follow-up scan (read-only), Sara call runner (1 queued call per run, opt-in only, simulation), alert digest; run history in automation_runs; disabled rules skipped.
- [x] Costs & Model page (`GET /api/zenvy/costs`) — **Zenvy platform owner only** (clinic owners, billers and viewers all get 403); UI tab hidden for everyone else.
- [x] Consistency fix found by this pass: the scrubber now accepts 'active' AND 'expiring' authorizations (an expiring auth still covers claims) and warns when an auth ends within 30 days; the alerts endpoint and dashboard count now include 'expiring' auths, so the scan can no longer hide an alert it just raised.

**Pass 4 — Integrations, risk, appeals, portal:**
- [x] Integrations page: 7 vendors (CentralReach, Rethink BH, Catalyst, Availity, Office Ally, Waystar, Twilio), status + exact authorization steps per vendor; EDI fields (270/271 refs on verifications, 276/277 status check, 837 batches, 835 ERA import); `setConnectionMode` to 'live' **refused** with a plain-language 409 for every vendor until real vendor accounts + approvals exist (refusal audited; 'off'/'simulation' allowed, Zenvy-owner-only).
- [x] Denial-risk score 0–100 with named factors (`src/risk.js`, reuses the scrubber as single source of truth): eligibility-pending +15, auth-units +35, eligibility-missing +25, eligibility-ineligible +40, auth-missing +20, auth-status +25, auth-cpt +15, auth-dates +15, duplicate +20, cpt-invalid +20, amount +10, auth expiring ≤7d +10 / 8–30d +5, prior denial +10, stale submitted >30d +10; capped at 100. Bands low 0–24 / medium 25–49 / high 50–100. Stored on the claim (`risk_score`, `risk_factors`), shown as a Risk column in the claims table.
- [x] Auto-appeal draft generator (`src/appeals.js`): payer-specific templates (Aetna CO-97 + generic fallback), known facts filled in, unknown items as [bracketed] placeholders; editable, downloadable (.txt), mark-as-filed (denial → 'appealing'), draft-only delete (denial kept); written-off denials cannot be appealed (409).
- [x] Sara dialer bridge: payer-call queue exports to CSV (`sara-call-queue-YYYY-MM-DD.csv`, queued items only); `importCallResults` imports outcomes back onto claims (paid → claim paid + open denials resolved; denied → claim denied + denial recorded; partial/pending/info-received logged only — partial payment goes via ERA posting); one bad row never fails the whole import (per-row failures reported); caller 'sara', source 'dialer-import', simulation labelled.
- [x] Clinic Portal: per-clinic owner view (`GET /api/portal`, clinic from `req.user.clinic_id` — never a parameter): own dashboard, claims, AR, alerts, subscription; Zenvy owner gets 403 (portal is for clinic owners); a clinic owner can never see another clinic's data.
- [x] Audit-log hardening: DB trigger blocking UPDATE/DELETE/TRUNCATE on `audit_log` (`db/migrations/005_pass4.sql`, `forbid_audit_log_change()` — **REAL-POSTGRES-ONLY**: pg-mem cannot run plpgsql `CREATE FUNCTION`/`CREATE TRIGGER`, and no Postgres binaries exist on this VM, so the trigger is first live-verified on Supabase at deploy; `src/migrate.js` skips marker files in test env but records them; the migrations test asserts the DDL is present).
- [x] End-to-end test pass (`test/pass4.test.js`, **63 checks PASS**) mirroring the artifact's verified tests + clean-up (demo data removed at the end).

**Explicitly NOT in scope (honest limits, unchanged from the artifact):**
- Live vendor sync (CentralReach/Rethink/Catalyst/Availity/Office Ally/Waystar) — needs
  each vendor's approval + the clinic's authorization; payer portals have no open APIs,
  EDI via clearinghouse is the route, never portal scraping.
- Live Sara calling — needs Twilio at deployment + Rza's Deepgram/Gemini keys.
- Real-money Paddle charges before beta clinics say yes.

## 5. Render deploy steps (free tier)

1. Rza creates a free **GitHub** account; this repo is pushed there (branch `main`).
2. Rza creates a free **Render** account (email signup, no card).
3. Supabase: free project → copy the Postgres connection string (pooler, `sslmode=require`).
4. Render → New → **Blueprint** → connect the repo (`render.yaml`: Node free service,
   `npm install` → `npm start`, health check `/health`).
5. Render dashboard → Environment: set `DATABASE_URL` (Supabase string),
   `APP_BASE_URL=https://app.zenvydigitals.online` (JWT_SECRET is generated by Render).
6. Deploy → watch logs → migrations run automatically → `GET /health` returns
   `{"ok":true,"db":"up"}`.
7. Cloudflare → DNS → **CNAME** `app` → the Render service address
   (Render provisions free SSL for the custom domain).
8. Full test pass (Pass 4 list) on the live URL → then the 10 beta emails.

## 6. Portability rules (Render → DigitalOcean, and anywhere else)

- **Dockerfile is the deploy contract.** The same image runs on Render (Docker web
  service) and on a Droplet (`docker run -d -p 80:3000 --env-file .env …`).
  No Render-specific code exists in the app; `render.yaml` is deploy config only.
- **All config in env vars.** Nothing host-specific is compiled in.
- **Standard Postgres only.** `pg` + plain SQL migrations; no Supabase/Neon/Render
  extensions. The database can move to any Postgres (Render Postgres, Droplet
  Postgres, Supabase Pro) by changing `DATABASE_URL` alone.
- **No platform cron dependency.** Scheduled work is an HTTP endpoint + external
  trigger (§1), so it works identically on Render and on a Droplet's cron.
- **State lives only in Postgres + env vars.** Nothing on the local filesystem
  (Render free instances have ephemeral disks; the Droplet would not, but the app
  must not depend on that).

## 7. DigitalOcean path (later, when revenue starts)

1. Rza's DigitalOcean account → **Droplet** (Ubuntu, $12–24/mo; the $200/60-day free
   credit covers the first two months if unused).
2. On the Droplet: install Docker → `docker run` the same image with the same `.env`
   (keep **Supabase as the database** — no data migration needed; only the web
   service moves). Optional later step: Postgres on the Droplet and one `pg_dump` /
   restore if Rza wants everything in one place.
3. Cloudflare → CNAME `app` → Droplet IP (or keep the Render service until the
   Droplet is verified, then switch the record — zero-downtime cutover).
4. Droplet `cron`: daily `curl` to `/api/internal/run-daily` (replaces the external
   pinger); keep the `CRON_SECRET` header.
5. Turn off / delete the Render service only after the Droplet passes the full test
   pass. First paying clinic ($500/mo) covers the Droplet ~20–40× over.

## 9. Verification log (Pass 3 — run 2026-11-23 ~22:30 PKT, Node 24)

- [x] `npm run test:migrations` — **PASS** (4 migrations, 18 tables, seeds OK).
- [x] `npm run test:pass3` (`test/pass3.test.js`, in-memory pg-mem + real Express over HTTP) — **PASS: 70 checks**, covering: subscription lifecycle trial → active → pause → resume → cancel → re-subscribe + audit + viewer/biller blocked; Paddle webhook 503 without secret, 401 on bad signature, trialing/canceled mapped via custom_data, non-subscription + unmapped events acknowledged; digest refused while alerts off, composed (2 items: auth expiry + appeal deadline), delivery recorded failed with honest Resend error, no duplicate same-day digest, digest history; 5 automation rules all on + toggle off/on; daily sweep runs all 5 (eligibility resolved with SIM-271 ref, auth marked expiring, alerts still list it, scrub still passes on expiring auth, call runner processed 1 queued Sara call as pending/simulation, no duplicate digest), disabled rule skipped in sweep, run history ≥5 rows, viewer/biller blocked from automation; internal sweep 503 without CRON_SECRET, 401 wrong secret, 200 correct secret; Costs & Model 200 for Zenvy owner, 403 for clinic owner + viewer; UI serves with Subscribe/Automation/Costs tabs + actions.
- [x] `npm run test:pass2` — **PASS (63 checks, unchanged)** — the scrubber + alerts fixes did not regress core.
- [x] `node --check` clean on all `src/**/*.js` + `public/app.js` + `test/pass3.test.js`.
- [x] Static UI check: all 29 `data-action` values and 16 `data-form` kinds have handlers; Subscribe/Automation/Costs tabs registered.
- [x] `npm start` (no DATABASE_URL) serves the full UI: `/health` 0.3.0-pass3 (`db: "not-configured"`), `/` 200, `/app.js` 200, `/style.css` 200, `/api/automation/rules` 401 without auth.
- **Bugs found + fixed during this pass:** (1) webhook router mounted at `/api/paddle/webhook` also defined `POST /webhook` — real path was `/webhook/webhook` (404); route is now `POST /`; (2) `/run/:ruleKey` caught `/run-daily` first (ruleKey='daily' → 404) — `/run-daily` is now defined before the parameterized route; (3) test-only: biller registration ran while logged in as viewer (register is owner-only) and `r.sweep` was used instead of `r.json.sweep`.
- **Still unverified (honest):** Dockerfile build (no Docker on this VM); real Supabase Postgres (no live DB yet — all tests are pg-mem); **email delivery to a real inbox is NOT proven** (Resend key not set; digests record 'failed' honestly until then); live Paddle charges (sandbox only until Rza's account is verified + keys set); live browser run-through of the UI.

## 9. Verification log (Pass 4 — final — run 2026-11-23 ~22:31–22:47 PKT, Node 24)

- [x] `npm run test:migrations` — **PASS** (5 migrations, 18 tables, seeds OK; 005 skipped in pg-mem by design — real-Postgres-only DDL, presence asserted).
- [x] `npm run test:pass4` (`test/pass4.test.js`, in-memory pg-mem + real Express over HTTP) — **PASS: 63 checks**, end-to-end on demo data: risk score clean claim LOW (5 — auth expiring in 9 days) / problem claim HIGH (50 — eligibility pending +15, auth units +35) with named factors, scores stored on the claims; scrub pass → clearinghouse submit accepted with `SIM-BATCH-*` ref + `SIM-*` payer claim #; ERA import 1 matched (posted → claim paid in full, $240) + 1 unknown line stored unmatched; EDI 276/277 check returns the paid claim in full with `EDI-276-SIM-*` / `EDI-277-SIM-*` refs stored on the claim; 837 batch listed (1 claim, $240 billed); Sara call queued → daily sweep runs all 5 rules, call runner processed 1 call, automated checks resolved T.K. eligibility to ELIGIBLE with `SIM-271-*` ref, auth scan raised expiring-auth alerts, alerts list the expiring auth + open appeal deadline; appeal draft generated (generic for the demo's UHC CO-97 denial; Aetna CO-97 template verified separately on an Aetna denial in the test clinic), edited + marked ready, downloaded as text, filed → denial 'appealing'; Sara queue exports to CSV (headers + queued claim + question); `importCallResults`: paid outcome → problem claim paid $480, denied outcome → fresh claim denied + CO-197 denial recorded, one bad row reported without failing the import; integrations list 7 vendors all simulation with steps, `setConnectionMode` to 'live' **refused 409** (Availity still simulation after), off/simulation allowed, clinic owner 403; portal: clinic owner sees own clinic only (no demo claim ids), dashboard + AR + alerts present, Zenvy owner 403; audit trigger DDL present, no audit DELETE endpoint (404), audit readable incl. the appeal 'file' entry; UI serves with Integrations/Appeals/Portal tabs + new actions; demo data removed + no longer reachable.
- [x] `npm run test:pass2` — **PASS (63 checks, unchanged)**.
- [x] `npm run test:pass3` — **PASS (70 checks, unchanged)**.
- [x] `node --check` clean on all new/edited files (`src/risk.js`, `src/appeals.js`, `src/integrations.js`, `src/calls.js`, `src/routes/{integrations,appeals,dialer,portal}.js`, `src/routes/{billing,demo}.js`, `src/appeals.js`, `public/app.js`, `test/pass4.test.js`).
- [x] Static UI check: all `data-action` values (39) and `data-form` kinds (20) have handlers; Integrations/Appeals/Portal tabs registered with renderers in `TAB_RENDER`.
- [x] `npm start` (no DATABASE_URL) serves the full UI: `/health` 0.4.0-pass4 (`db: "not-configured"`), `/` 200, `/app.js` 200, `/style.css` 200, `/api/integrations` + `/api/portal` 401 without auth.
- **Bugs found + fixed during this pass:** (1) Aetna template never fired — `templateKeyFor` normalizes 'CO-97' to 'co97' but the template key was written 'aetna-co-97'; key renamed to 'aetna-co97' (the human label still reads 'Aetna — CO-97'); (2) demo remove crashed on `era_lines` FK — the remove route assumed no ERA lines exist in demo, but Pass 4's e2e creates them; remove now deletes `era_lines` before claims; (3) test-only: `r.demo`/`r.portal` used instead of `r.json.demo`/`r.json.portal`; the audit check read the wrong clinic's log (appeal audits belong to the demo clinic); the demo denial is UHC, not Aetna, so the Aetna template is now verified on a separate Aetna denial.
- **Still unverified (honest):** Dockerfile build (no Docker on this VM); real Supabase Postgres (no live DB yet — all tests are pg-mem; **the audit-log trigger has never run anywhere** — pg-mem cannot execute plpgsql `CREATE FUNCTION`/`CREATE TRIGGER` and no Postgres binaries exist on this VM, so it is first live-verified on Supabase at deploy); **email delivery to a real inbox is NOT proven** (no Resend key); live Paddle charges (sandbox only until Rza's account is verified + keys set); live browser run-through of the UI (no live browser in this session — every UI action's API is covered by the 196 checks across pass2/3/4, but clicks were not exercised in a browser); no live vendor connection exists for any of the 7 vendors (all simulation, by design).
- **Deploy-ready state:** the app is complete to the final spec — pending only Rza's accounts: GitHub (repo push), Render (host), Supabase (live database — run migrations, first live check of the audit trigger), Paddle verification (live charges). Then: full test pass on the live URL → 10 beta emails.

## 8. Verification log (Pass 1 — run 2026-11-23 ~22:06 PKT, Node 24 / npm 10)

- [x] `npm install` clean (147 packages, no errors).
- [x] `npm run test:migrations` — **PASS**: 3 migrations applied, 18 tables present,
  seeds OK (5 automation rules, 7 vendor connections in Simulation mode).
- [x] `npm start` + `GET /health` → `{"ok":true,"service":"zenvy-billing-platform",
  "version":"0.1.0-scaffold","db":"not-configured"}` without `DATABASE_URL`.
- [x] `GET /` serves the branded placeholder (Zenvy navy `#0b1f3a` + gold `#c9a227`).
- [x] `GET /api/claims` → 404 placeholder ("API not built yet") — expected in Pass 1.
- [ ] Dockerfile builds — **cannot be verified on this VM (no Docker installed)**;
  first build happens on Render deploy (or on the Droplet).
- **Bugs found + fixed during this pass:** (1) two forward foreign keys in
  `002_billing.sql` (`sessions.claim_id`, `payer_calls.queue_id`) that real Postgres
  rejects — moved to `ALTER TABLE` at end of file; (2) pg-mem test gaps
  (`char_length` unimplemented, no `pg_tables` view) — fixed in the test, not in
  the production SQL.

## 9. Verification log (Pass 2 — run 2026-11-23 ~22:15–22:25 PKT, Node 24)

- [x] `npm run test:migrations` — **PASS** (unchanged).
- [x] `npm run test:pass2` (`test/pass2.test.js`, in-memory pg-mem + real Express
  over HTTP) — **PASS: 63 checks**, covering: bootstrap owner + login, BAA gate
  (patient + referral rejected without BAA), initials-only rejection, viewer
  write blocked + viewer read allowed, referral → patient conversion, auth
  expiry scan (9 days left, 8 units), session → draft claim, scrub FAIL on
  auth-units + submit gate 409, scrub PASS after fix, partial-update merge
  (notes-only patch keeps CPT + DOS), clearinghouse submit (SIM-BATCH-* +
  SIM-* refs, simulation flag), denial recorded, payer-call queue refused
  without opt-in then allowed after opt-in, call outcome paid → claim paid
  + denial auto-resolved, ERA import 1 matched / 1 unmatched + post pays
  claim in full + manual match, AR buckets, dashboard recovered > 0, weekly
  report, claim delete unlinks session, claim with denial/call history
  blocked with plain message, patient with billing records blocked,
  patient without records deletes + referral closed, CSV preview
  (1 ready / 1 needs-fixing / 1 duplicate) + import (1 inserted / 1 skipped /
  1 failed) + export + template, demo load (dashboard recovered $240) +
  double-load refused + remove, audit log contains create/update/submit/
  scrub/login, clinic-with-data delete blocked.
- [x] `node --check` clean on all `src/**/*.js` + `public/app.js`.
- [x] `npm start` (no DATABASE_URL) serves the full UI: `/` 200, `/style.css`
  200 (Google-style restyle verified served), `/app.js` 200, unknown API 404.
- [x] UI static consistency check: every `data-form` kind and `data-action`
  has a handler; all 14 tabs have a renderer (the `'draft'` hit in the
  rough check was the `['draft','ready']` array literal — false positive).
- [x] UI bug found + fixed: a Zenvy owner with zero clinics could not reach
  Settings to create the first clinic — Settings now renders a no-clinic
  view (create clinic + demo data) when no clinic is selected.
- **Bugs found + fixed during this pass:** (1) pg-mem mishandles
  `IS NOT NULL` on parameter-inserted DATE columns (alerts query returned 0
  rows) — removed the redundant `IS NOT NULL` (the `<=` comparison already
  excludes NULLs) in 3 queries; (2) ERA match/post handlers used
  `claimRows.length` on the pg result object instead of `claimRows.rows`
  (one real crash: `paid_amount` of undefined) — fixed in both handlers;
  (3) test-only gap: ERA-test claim had no eligibility verification — added
  it to the test (the scrubber was correctly refusing).
- **Still unverified (honest):** Dockerfile build (no Docker on this VM);
  real Supabase Postgres (no live DB yet — all tests are pg-mem); live
  browser run-through of the UI (no live browser in this session — the API
  behind every UI action is covered by the 63 checks, but clicks were not
  driven in a real browser).
