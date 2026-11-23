# Zenvy Digitals Billing Platform — standalone rebuild

ABA therapy billing for US clinics. Node.js + Express + Postgres, deployed on
**Vercel (Hobby, serverless)** at **app.zenvydigitals.online**. This is the standalone rebuild of the
Muse fullstack artifact `zenvy-digitals-billing-platform` (which cannot be
exported or made public). Same features, same Zenvy navy + gold branding.

**Status: Pass 5 — public trial signup + pro auth screens + clinic-scoped access built + verified (pass2 66 + pass3 70 + pass4 63 + pass5 44 = 243 checks pass).** Auth,
clinics + flags, patients/referrals + BAA gate, verifications, authorizations
+ expiry scan, sessions → draft claims, claims + scrubber + submit gate,
clearinghouse submit (simulation), denials, payer calls (opt-in enforced),
ERA import/match/post, AR aging + reports + dashboard, audit log, CSV
import/export, demo data loader, full app UI — plus: Paddle subscriptions
($500/mo, 7-day trial, lifecycle + webhook), email alert digests (Resend,
delivery recorded honestly), 5 automation rules + daily sweep, Costs & Model
(Zenvy owner only) — plus: Integrations page (7 vendors, live mode refused
honestly), denial-risk score 0–100 with named factors, auto-appeal drafts
(Aetna CO-97 + generic), Sara dialer bridge (queue CSV export + call-result
import), Clinic Portal (own clinic only), audit-log DB trigger — plus now:
public 7-day trial signup (no login) at `https://app.zenvydigitals.online/#trial`,
clinic-scoped owner accounts, split-screen auth with product showcase,
dashboard Quick-Start checklist + trial banner — see [PLAN.md](PLAN.md)
for the build order and the verification log. Live on Vercel at
**app.zenvydigitals.online** (Hobby); pending only Rza's steps: Supabase
SQL Editor migrations (001–006), Vercel env vars, daily-sweep cron.
(Render is BLOCKED — Rza's account is asked for a card at service creation;
Koyeb free tier is dead since Feb 2026 and Zeabur's free hosted tier is gone.
See DEPLOY.md.)

## Public trial signup (Pass 5)

A clinic with no account signs up from the website's Subscribe button:

**Trial signup URL: https://app.zenvydigitals.online/#trial**

`POST /api/public/start-trial` (no login) takes clinic name, your name, work
email, password (min 8 chars) and creates the clinic (status `trial`,
trial_ends_at = today + 7 days, $500/month plan) + a clinic-scoped owner
account (role `clinic`), then signs them in and lands them on the dashboard
with the Quick-Start checklist and a one-click sample-data loader. One trial
per email; max 5 signup attempts/hour per IP. The hard BAA gate still blocks
real patient entry until the clinic records its BAA. Trial owners see and
manage only their own clinic — never other clinics, Costs & Model, or
platform administration. The logged-out screen is a split screen: product
showcase on the left, sign-in on the right.

Neither Render free nor Vercel runs the sweep natively, so the daily sweep is an HTTP endpoint:
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

## Deploy (Vercel Hobby — current route)

1. Supabase SQL Editor → run `db/all-migrations.sql` once (see DEPLOY.md A1),
   then verify the audit-log trigger.
2. Vercel → Sign Up with GitHub → Add New → Project → Import this repo.
3. In Vercel set `DATABASE_URL` (Supabase **session pooler** string),
   `JWT_SECRET`, `NODE_ENV=production`, `APP_BASE_URL`, `CRON_SECRET`.
4. Deploy → `https://<project>.vercel.app` → check `/health` (`db: "up"`).
5. Custom domain: `app.zenvydigitals.online` → Vercel (CNAME in Cloudflare;
   Vercel provisions free SSL). Full steps in PLAN.md §5b and DEPLOY.md.
6. Daily sweep: external cron (cron-job.org, free) POSTs
   `/api/internal/run-daily` with `x-cron-secret` — Vercel Cron is NOT used
   (legacy cron is GET-only and cannot send the custom header).

Vercel Hobby limits (verified Oct–Nov 2026): 300 s max function duration;
2 GB / 1 vCPU; 1M invocations, 100 GB transfer, 4 h active CPU per month;
cold starts after idle. **Hobby is for personal, non-commercial use
(Vercel's terms)** — move to Pro ($20/seat/mo) once the first clinic pays.

## Deploy (Render — BLOCKED)

Render asks Rza's account for a card at service creation (account-level
anti-fraud check) — Blueprint and direct Web Service alike. The app still
supports it (`npm start`, `Dockerfile`, `render.yaml` untouched) if the card
check is ever cleared; see DEPLOY.md Route B. Do NOT use Koyeb or Zeabur
(both free tiers are dead since Feb 2026).

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
- The Zenvy platform owner can delete an empty clinic from Settings — a clinic holding billing records refuses with a plain message (409), never a silent delete; clinic-scoped users never see the button.
