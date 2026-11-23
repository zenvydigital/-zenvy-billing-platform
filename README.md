# Zenvy Digitals Billing Platform — standalone rebuild

ABA therapy billing for US clinics. Node.js + Express + Postgres, deployed on
Render at **app.zenvydigitals.online**. This is the standalone rebuild of the
Muse fullstack artifact `zenvy-digitals-billing-platform` (which cannot be
exported or made public). Same features, same Zenvy navy + gold branding.

**Status: Pass 4 (final) — all features built + verified (pass2 63 + pass3 70 + pass4 63 checks pass).** Auth,
clinics + flags, patients/referrals + BAA gate, verifications, authorizations
+ expiry scan, sessions → draft claims, claims + scrubber + submit gate,
clearinghouse submit (simulation), denials, payer calls (opt-in enforced),
ERA import/match/post, AR aging + reports + dashboard, audit log, CSV
import/export, demo data loader, full app UI — plus: Paddle subscriptions
($500/mo, 14-day trial, lifecycle + webhook), email alert digests (Resend,
delivery recorded honestly), 5 automation rules + daily sweep, Costs & Model
(Zenvy owner only) — plus now: Integrations page (7 vendors, live mode refused
honestly), denial-risk score 0–100 with named factors, auto-appeal drafts
(Aetna CO-97 + generic), Sara dialer bridge (queue CSV export + call-result
import), Clinic Portal (own clinic only), audit-log DB trigger — see [PLAN.md](PLAN.md)
for the build order and the verification log. Deploy-ready, pending only
Rza's accounts (GitHub, Render, Supabase, Paddle verification).

## Daily sweep (Pass 3)

Render free has no cron jobs, so the daily sweep is an HTTP endpoint:
`POST /api/internal/run-daily` with header `x-cron-secret: <CRON_SECRET>`.
Schedule it with a free external pinger (UptimeRobot / cron-job.org):
automated checks sweep ~07:45 PKT, alert digest ~08:30 PKT — one call runs
both (the sweep runs all 5 enabled rules in order). The same sweep runs
from the Automation tab (Zenvy owner only). On DigitalOcean the Droplet's
own `cron` calls the same endpoint. Until a live Supabase database exists,
the sweep runs against whatever DATABASE_URL is set — with no database it
cannot run (the server still starts; `/health` reports `db: "not-configured"`).

## Weekly database export (runbook — until a paid plan adds backups)

Supabase Free has **no automatic backups**. Until the move to a paid plan,
export the database **every week** (same day each week — pick Monday):

1. Open the Supabase dashboard → your project → **Database → Backups**
   (or use the SQL editor / `pg_dump` from any machine with Postgres):
   `pg_dump "$DATABASE_URL" -F c -f zenvy-backup-YYYY-MM-DD.dump`
   (use the **direct** connection string, not the pooler, for pg_dump).
2. Store the file somewhere safe **outside** Supabase (your own computer
   + a second copy, e.g. Google Drive). Never commit it to the repo.
3. Restore test (once a month): create an empty database and run
   `pg_restore -d <empty-db> zenvy-backup-YYYY-MM-DD.dump`, then check
   the clinic count matches the live one.
4. If the Supabase project ever **pauses** (1 week of inactivity): restore
   it from the dashboard (one click, no data lost) — the daily sweep +
   health check normally prevent pauses on a live beta.
5. When the first clinic pays: move to Supabase Pro (daily backups) or
   Postgres on the DigitalOcean Droplet — then this runbook retires.

## Quick start (local)

```bash
cp .env.example .env        # fill DATABASE_URL (Supabase) when you have one
npm install
npm run test:migrations     # SQL smoke test (in-memory, no live DB needed)
npm start                   # → http://localhost:3000/health
```

Without `DATABASE_URL` the server still starts and `/health` reports
`db: "not-configured"`. With it set, migrations run automatically at startup.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Blueprint → connect the repo (`render.yaml`).
3. In the Render dashboard set `DATABASE_URL` from the Supabase project.
4. Custom domain: `app.zenvydigitals.online` → Render service (CNAME in
   Cloudflare; Render provisions free SSL). Full steps in PLAN.md.

## Rules (never break)

- No real credentials, API keys or patient data in code or files. Ever.
- Patients by **initials only**. No full names, no DOB.
- Real (non-demo) patient/referral data requires the clinic's **BAA signed**.
- Payer calls (Sara) are **opt-in per clinic, OFF by default**, server-enforced.
- `audit_log` is **append-only**.
- Everything vendor-related runs in labelled **Simulation mode** until the real
  vendor account, credentials and approvals exist. The platform refuses to
  show any connection as live until then. No portal scraping, ever — EDI via
  clearinghouse is the real route.
- Partial updates **merge** with stored values — an omitted field is never blanked.
- Deletes **unlink** linked records and show plain-language messages, never raw SQL.
