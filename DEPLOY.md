# Deploy runbook — Zenvy Digitals Billing Platform

App is deploy-ready (Pass 4 + Vercel adapter, 199 checks pass). Deploy needs only Rza's accounts.

> 2026-11-24: bootstrap-register bug fixed — POST /api/auth/register now sets the session cookie for the first (owner) account, so the first-run setup screen signs the owner in instead of 401ing on /api/auth/me (commit on main; Vercel auto-redeploys).

## 0. Prereqs (Rza, all free)
- GitHub account + repo `zenvydigital/-zenvy-billing-platform` (code already pushed, 55 files, branch `main`)
- Supabase account + project `zenvy-billing-platform` (free tier)
- **Host — Vercel Hobby (current route, no card)** — see Route A below.
  Render is Route B, **BLOCKED**: Render asks Rza's account for a card at
  Blueprint/Web Service creation (account-level anti-fraud check, $1 hold).
  Koyeb is DEAD (free tier closed Feb 2026, Mistral acquisition — $29/mo).
  Zeabur's free hosted tier is also gone (Feb 2026).

## Route A — Vercel (Hobby, serverless, no card) — CURRENT

### A1. Supabase — run the migrations ONCE (do this FIRST)
1. Supabase dashboard → your project → **SQL Editor** → **New query**.
2. Open `db/all-migrations.sql` from the repo (GitHub → `db/all-migrations.sql` → Raw → copy all),
   paste the whole file into the SQL Editor → **Run**.
   It creates all 18 tables, seeds the 5 automation rules + 7 vendor connections,
   adds the Paddle columns, installs the audit-log trigger, and records all 5
   files in `schema_migrations`. Re-running it on real Postgres is safe.
3. **Verify the audit-log trigger on live Postgres** (never executed anywhere yet —
   pg-mem cannot run plpgsql; no Postgres on the build VM):
   in the SQL Editor run:
   `UPDATE audit_log SET action='x' WHERE false;` — it must ERROR
   (trigger blocks it).
   And: `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%audit%';` —
   it must list `audit_log_no_update` and `audit_log_no_truncate`.
4. Weekly: export the DB (`pg_dump`) per the README runbook — Supabase Free has no auto-backups.
   Free projects pause after 1 week idle; the daily sweep hits the DB every day, which
   keeps it awake.

### A2. Supabase — copy the connection string (session pooler, NOT direct)
1. Supabase dashboard → **Connect** → **Direct** tab → **Session pooler** → copy the
   connection string (URI form, `postgresql://postgres.<ref>:<password>@aws-0-us-west-2.pooler.supabase.com:5432/postgres`).
   **Use the Session pooler, not Direct connection:** Direct is IPv6-only and
   Vercel's functions reach it over IPv4 — the pooler is the IPv4 route.
   Replace `[YOUR-DATABASE-PASSWORD]` with the DB password chosen at project creation.
   (If the password has special characters, percent-encode them, or reset it to
   letters+numbers only via **Reset database password**.)
2. **Never paste this string in chat.** It goes only into Vercel's Environment Variables below.

### A3. Vercel — import the repo and deploy
1. [vercel.com](https://vercel.com) → **Sign Up** → **Continue with GitHub**
   (Hobby plan, $0 — no card asked at signup).
2. **Add New → Project** → **Import Git Repository** → select
   `zenvydigital/-zenvy-billing-platform` → **Import**.
3. Configure the project (Vercel auto-detects; leave defaults unless noted):
   - Framework Preset: **Other** (no framework — plain Node + Express)
   - Root Directory: `./` (default)
   - Build Command: leave empty/default (no build step; Vercel runs `npm install`)
4. **Environment Variables** (add each, then Deploy):
   - `DATABASE_URL` = the Supabase session-pooler string from A2
   - `JWT_SECRET` = a long random string you type yourself (any long random
     mix of letters + numbers, 40+ characters — never reuse a password)
   - `NODE_ENV` = `production`
   - `APP_BASE_URL` = `https://<your-project>.vercel.app` for now (the URL
     Vercel gives you — update it to `https://app.zenvydigitals.online` after A5)
   - `CRON_SECRET` = another long random string (different from JWT_SECRET) —
     the external daily-sweep caller sends it as the `x-cron-secret` header
   - Leave `RESEND_API_KEY`, `PADDLE_*`, `TWILIO_*`, `DEEPGRAM_API_KEY`,
     `GEMINI_API_KEY` empty until those accounts/keys exist (app runs without
     them; features show honest "not-configured" status).
5. **Deploy** → wait for the build → the app is live at
   `https://<your-project>.vercel.app`.
6. Check `/health` on that URL — it must answer
   `{"ok":true,"db":"up",...}`. If it says `"db":"down"`, the DATABASE_URL is
   wrong (usually the password) — fix it in Vercel → Settings → Environment
   Variables and redeploy.

### A4. Daily sweep (external cron — Vercel Cron is NOT used)
Vercel's legacy Cron Jobs call a route with GET and cannot send our custom
`x-cron-secret` header, so the sweep stays on an external caller, exactly as
designed (`POST /api/internal/run-daily`, header `x-cron-secret: <CRON_SECRET>`):
1. [cron-job.org](https://cron-job.org) (free) → sign up → **Create cronjob**.
2. URL: `https://<your-app-url>/api/internal/run-daily`, method **POST**,
   header `x-cron-secret: <the same CRON_SECRET you set in Vercel>`.
3. Schedule: daily, ~07:45 PKT (02:45 UTC) — one call runs the sweep + digest.
   (Alert digests are composed by the same sweep; the ~08:30 PKT digest slot
   from the Render plan is the same single call — no second job needed.)
4. Until a live Supabase database exists, the sweep cannot run (the server
   still starts; `/health` reports `db: "not-configured"`).

### A5. Domain — app.zenvydigitals.online (free, no purchase)
1. Vercel project → **Settings → Domains** → add `app.zenvydigitals.online`.
   Vercel shows the DNS record to add (a CNAME to `cname.vercel-dns.com`).
2. Cloudflare → zenvydigitals.online → DNS → add **CNAME**: Name `app`,
   value `cname.vercel-dns.com` (or exactly what Vercel shows). Vercel
   provisions free SSL for the custom domain automatically.
   The subdomain is part of the domain Rza already owns — no extra purchase.
3. After DNS propagates, update `APP_BASE_URL` in Vercel env vars to
   `https://app.zenvydigitals.online` and redeploy.

### A6. Verify on the live URL
1. `/health` answers `{"ok":true,"db":"up"}`.
2. Bootstrap the owner account (first-user flow), log in, create a clinic.
3. BAA gate: real patient entry refused before BAA; allowed after.
4. Scrubber: problem claim fails → fix → passes → submit accepted.
5. Audit trigger check (A1.3) re-confirmed on live data.
6. Demo data load → dashboard shows recovered money → remove demo data.
7. Paddle: only after Rza's Paddle account is verified + domain `app.zenvydigitals.online`
   approved in Paddle → Website approval → set keys in Vercel env → test Subscribe flow
   in sandbox first, then live.

### A7. Honest Vercel Hobby limits (verified Oct–Nov 2026 from Vercel's own docs)
- **Function max duration 300 s** (5 min) — default and maximum on Hobby; a run
  past it returns 504 `FUNCTION_INVOCATION_TIMEOUT`. Normal billing clicks are
  seconds; only a huge CSV import or report could approach it.
- **Memory 2 GB / 1 vCPU per function; 1M invocations, 100 GB transfer,
  4 h active CPU, 360 GB-hours provisioned memory per month.** Enough for a
  beta with a handful of clinics; a usage spike pauses that feature until the
  monthly reset.
- **Cold starts:** functions sleep when idle; the first request after idle takes
  a few seconds (cold start + DB pool connect). Normal after that.
- **Cron (legacy) on Hobby: once per day max, fires anywhere inside the
  scheduled hour, UTC only** — not used here (external cron instead, A4).
  Vercel Schedules (public beta, Nov 2026) allow every 15 min on Hobby with a
  5,000-runs/billing-period budget — a future option, not used now.
- **Hobby is for personal, non-commercial use (Vercel's terms).** Zenvy is a
  commercial SaaS — Hobby is the $0 start, but the honest path is Pro
  ($20/seat/month) once the first clinic pays $500/mo.
- **Unverified:** no live Vercel deploy has run yet (Rza does the import);
  the serverless path is verified locally only (mock invocation harness);
  cold-start latency not measured; the audit trigger + the two guarded
  `DO` blocks in `all-migrations.sql` have never run on real Postgres yet —
  their first live run is step A1.

## Route B — Render (BLOCKED — card verification on Rza's account)
1. Render dashboard → New → Web Service → connect the GitHub repo.
   (Blueprint was tried first — same card wall. The form pre-selects paid
   Starter $7/mo — switch it to **Free**.)
2. Build command: `npm install` — Start command: `npm start`.
3. Environment variables (Render dashboard → Environment):
   - `DATABASE_URL` = Supabase session-pooler string (see A2 — same string)
   - `JWT_SECRET` = long random string (Render's form has a Generate button)
   - `NODE_ENV` = `production`
   - `APP_BASE_URL` = `https://app.zenvydigitals.online`
   - Leave `RESEND_API_KEY`, `PADDLE_*`, `TWILIO_*`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`
     empty until those accounts/keys exist.
4. First build happens here (Dockerfile build unverified — watch the Render build log).
5. Free tier sleeps after 15 min idle (~1 min wake on first visit). Move to paid
   ($7/mo service) once the first clinic pays.
6. Domain (if Render is ever used): Cloudflare → CNAME `app` → the Render
   service address (`*.onrender.com`); Render provisions free SSL.

## 6. Website software section (zenvydigitals.online)
Add at deploy time: Service $3,500/mo (done-for-you) vs Software $500/mo (14-day free
trial) with the Subscribe button linking to `https://app.zenvydigitals.online`.

## 7. After deploy is live + tested
Send the 10 beta emails (list in MEMORY.md). Then: DigitalOcean shift (after first
clinic pays — $200 trial), Paddle live charges, Resend key for real email delivery.
