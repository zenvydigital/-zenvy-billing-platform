# Deploy runbook — Zenvy Digitals Billing Platform

App is deploy-ready (Pass 4, 196 checks pass). Deploy needs only Rza's accounts.

## 0. Prereqs (Rza, all free)
- GitHub account + empty public repo `zenvy-billing-platform`
- Render account (free tier)
- Supabase account + project `zenvy-billing-platform` (free tier)

## 1. Push the code to GitHub
```bash
cd ~/workspace/zenvy-platform-rebuild
git init
git add .
git commit -m "Zenvy Billing Platform v0.4.0-pass4"
git branch -M main
git remote add origin https://github.com/<RZA-GITHUB-USERNAME>/zenvy-billing-platform.git
git push -u origin main
```
Needs a GitHub Personal Access Token (fine-grained, contents: write) from Rza via
the secure vault — never in chat, never in code. `.env` is git-ignored; only
`.env.example` is committed.

## 2. Supabase — live database
1. In the Supabase project: Settings → Database → copy the **connection string**
   (URI form, `postgresql://postgres:<password>@...` — the password is the one
   chosen at project creation).
2. Run migrations against it once (from a machine with the repo + DATABASE_URL set):
   `npm run migrate`
3. **Verify the audit-log trigger on live Postgres** (never executed anywhere yet —
   pg-mem cannot run plpgsql): connect with psql and run
   `UPDATE audit_log SET action='x' WHERE false;` — it must ERROR (trigger blocks it).
   Also confirm the trigger exists: `SELECT * FROM pg_trigger WHERE tgname LIKE '%audit%';`
4. Weekly: export the DB (`pg_dump`) per the README runbook — Supabase Free has no auto-backups.
   Free projects pause after 1 week idle; the daily sweep hits the DB every day, which
   keeps it awake.

## 3. Render — web service (free tier)
1. Render dashboard → New → Web Service → connect the GitHub repo.
2. Build command: `npm install` — Start command: `npm start`.
3. Environment variables (Render dashboard → Environment):
   - `DATABASE_URL` = Supabase connection string from step 2
   - `JWT_SECRET` = long random string (generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
   - `NODE_ENV` = `production`
   - `APP_BASE_URL` = `https://app.zenvydigitals.online` (after step 4)
   - Leave `RESEND_API_KEY`, `PADDLE_*`, `TWILIO_*`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`
     empty until those accounts/keys exist (app runs without them; features show honest
     "not-configured" status).
4. First build happens here (Dockerfile build unverified — watch the Render build log).
5. Free tier sleeps after 15 min idle (~1 min wake on first visit). Move to paid
   ($7/mo service) once the first clinic pays.

## 4. Domain — app.zenvydigitals.online (free, no purchase)
Cloudflare → zenvydigitals.online → DNS → add **A record**: Name `app`, value = the
Render service's IP/hostname shown in the Render dashboard (or a CNAME to the
`*.onrender.com` hostname). Then in Render → service → Settings → Custom Domain →
add `app.zenvydigitals.online` (Render provisions free SSL). The subdomain is part of
the domain Rza already owns — no extra purchase.

## 5. Verify on the live URL
1. `/health` answers `{"ok":true,...}` with `db: "configured"`.
2. Bootstrap the owner account (first-user flow), log in, create a clinic.
3. BAA gate: real patient entry refused before BAA; allowed after.
4. Scrubber: problem claim fails → fix → passes → submit accepted.
5. Audit trigger check (step 2.3) re-confirmed on live data.
6. Demo data load → dashboard shows recovered money → remove demo data.
7. Paddle: only after Rza's Paddle account is verified + domain `app.zenvydigitals.online`
   approved in Paddle → Website approval → set keys in Render env → test Subscribe flow
   in sandbox first, then live.

## 6. Website software section (zenvydigitals.online)
Add at deploy time: Service $3,500/mo (done-for-you) vs Software $500/mo (14-day free
trial) with the Subscribe button linking to `https://app.zenvydigitals.online`.

## 7. After deploy is live + tested
Send the 10 beta emails (list in MEMORY.md). Then: DigitalOcean shift (after first
clinic pays — $200 trial), Paddle live charges, Resend key for real email delivery.
