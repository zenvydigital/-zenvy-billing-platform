-- ============================================================================
-- all-migrations.sql — Zenvy Digitals Billing Platform (Vercel deploy).
-- Run ONCE in the Supabase dashboard: SQL Editor -> paste this whole file
-- -> Run. It creates all 18 tables, seeds the 5 automation rules + 7 vendor
-- connections, adds the Paddle columns, installs the audit-log trigger,
-- and widens the user/audit role checks for the 'clinic' role (Pass 5).
--
-- SOURCE: verbatim concatenation of db/migrations/001_core.sql ..
-- 006_pass5.sql, in order, with exactly TWO adjustments so this file is
-- safe to re-run (the original migration files are UNCHANGED):
--   (1) 002_billing.sql's two ALTER TABLE ... ADD CONSTRAINT statements are
--       wrapped in guarded DO blocks (a plain ADD CONSTRAINT errors if the
--       script runs twice, which would abort the file before 005 applies).
--   (2) 004_pass3.sql's two ADD COLUMN statements use IF NOT EXISTS.
-- Everything else (CREATE TABLE/INDEX IF NOT EXISTS, INSERT ... ON CONFLICT
-- DO NOTHING, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS) was
-- already idempotent. The footer records all 6 files in schema_migrations,
-- so a later `npm run migrate` (Render/local) skips them as already applied.
--
-- After running: verify with the two checks in DEPLOY.md (audit trigger
-- blocks UPDATE on audit_log; pg_trigger lists audit_log_no_update).
-- Re-running this file on real Postgres is safe (CREATE TABLE IF NOT
-- EXISTS is a no-op there). pg-mem cannot re-run it — that is an emulator
-- limit, not a SQL problem; the file has never run on real Postgres yet
-- (no Postgres exists on the build VM), so its first live run is the
-- Supabase SQL Editor step in DEPLOY.md.
-- NEVER put credentials in this file. No secrets are in it.
-- ============================================================================


-- ==================== 001_core.sql ====================
-- 001_core.sql — clinics, users, patients, referrals, verifications, authorizations
-- Zenvy Digitals Billing Platform. Plain Postgres DDL (no extensions, no triggers)
-- so migrations also run in the pg-mem smoke test.
--
-- App-layer rules these tables rely on (enforced in code, not DDL):
--   * Patients are stored by INITIALS ONLY (never full names, never DOB).
--   * Real (non-demo) patients/referrals require the clinic's BAA signed.
--   * Partial updates MERGE with stored values — an omitted field is never blanked.
--   * Payer calls are OPT-IN per clinic, OFF by default (payer_calls_opt_in).

CREATE TABLE IF NOT EXISTS clinics (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  -- Privacy / consent flags (owner-only to change)
  baa_signed BOOLEAN NOT NULL DEFAULT FALSE,
  payer_calls_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  -- Email alerts
  alerts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  alert_email TEXT,
  -- Subscription ($500/month per clinic; trial -> active -> paused/cancelled)
  subscription_status TEXT NOT NULL DEFAULT 'none'
    CHECK (subscription_status IN ('none', 'trial', 'active', 'paused', 'cancelled')),
  subscription_plan TEXT NOT NULL DEFAULT 'platform-500',
  trial_ends_at DATE,
  -- Demo data marker (demo clinic + everything under it is clearly labelled)
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
  -- clinic_id NULL = Zenvy platform owner (sees Costs & Model, all clinics).
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'biller', 'viewer')),
  -- viewer: read-only (server-enforced); biller: works billing; owner: everything.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_clinic ON users(clinic_id);

CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  initials TEXT NOT NULL CHECK (char_length(initials) <= 10),
  payer TEXT,
  member_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'discharged')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, initials, member_id)
);
CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  -- Converted referral links to the patient it became; unlink (not delete) on patient delete.
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  referral_initials TEXT NOT NULL CHECK (char_length(referral_initials) <= 10),
  source TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'converted', 'closed')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referrals_clinic ON referrals(clinic_id);

CREATE TABLE IF NOT EXISTS verifications (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  payer TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'eligible', 'ineligible')),
  coverage_start DATE,
  coverage_end DATE,
  notes TEXT,
  -- EDI 270/271 references (filled when the clearinghouse goes live)
  edi_270_ref TEXT,
  edi_271_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verifications_patient ON verifications(patient_id);

CREATE TABLE IF NOT EXISTS authorizations (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  auth_number TEXT NOT NULL,
  payer TEXT,
  cpt_codes TEXT, -- e.g. '97153,97155'
  total_units INTEGER NOT NULL DEFAULT 0,
  units_used INTEGER NOT NULL DEFAULT 0,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expiring', 'expired', 'exhausted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, auth_number)
);
CREATE INDEX IF NOT EXISTS idx_auths_patient ON authorizations(patient_id);
CREATE INDEX IF NOT EXISTS idx_auths_end_date ON authorizations(end_date);

-- ==================== 002_billing.sql ====================
-- 002_billing.sql — sessions, claims, denials, payer calls, appeals, ERA lines
-- Zenvy Digitals Billing Platform.
--
-- App-layer rules these tables rely on (enforced in code, not DDL):
--   * Scrub gate: a claim CANNOT be marked submitted until scrub passes.
--   * Denial-risk score is rule-based 0-100 with named factors (stored on claim).
--   * Deletes unlink linked records; a claim with a denial or logged payer call
--     keeps its record (RESTRICT below); ERA lines are financial records and
--     are never deleted with a claim (SET NULL).

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  -- Auth delete unlinks sessions (they keep their record).
  authorization_id INTEGER REFERENCES authorizations(id) ON DELETE SET NULL,
  -- claim_id FK is added by ALTER TABLE at the end of this file: claims is
  -- created after sessions, and real Postgres rejects a forward reference
  -- (pg-mem lets it slide — do not rely on that).
  claim_id INTEGER,
  session_date DATE NOT NULL,
  cpt_code TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  duration_min INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'billed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patient_id);
CREATE INDEX IF NOT EXISTS idx_sessions_claim ON sessions(claim_id);

CREATE TABLE IF NOT EXISTS claims (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  authorization_id INTEGER REFERENCES authorizations(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  date_of_service DATE NOT NULL,
  cpt_code TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  billed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'submitted', 'partial', 'paid', 'denied')),
  -- Scrubber verdict (scrubclaim): pass / fail + error list; fail blocks submit.
  scrub_status TEXT NOT NULL DEFAULT 'not-run'
    CHECK (scrub_status IN ('not-run', 'passed', 'failed')),
  scrub_errors JSONB NOT NULL DEFAULT '[]',
  -- Denial-risk score 0-100 + named factors (scoreclaimrisk)
  risk_score INTEGER CHECK (risk_score BETWEEN 0 AND 100),
  risk_factors JSONB NOT NULL DEFAULT '[]',
  -- Clearinghouse / payer references
  clearinghouse_batch_ref TEXT,
  payer_claim_number TEXT,
  edi_276_ref TEXT,
  edi_277_ref TEXT,
  notes TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_clinic_status ON claims(clinic_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_patient ON claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_claims_payer_number ON claims(payer_claim_number);

CREATE TABLE IF NOT EXISTS denials (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  denial_code TEXT, -- e.g. CO-97, CO-197
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'appealing', 'appealed', 'written-off')),
  appeal_deadline DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_denials_claim ON denials(claim_id);
CREATE INDEX IF NOT EXISTS idx_denials_deadline ON denials(appeal_deadline);

CREATE TABLE IF NOT EXISTS payer_calls (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  -- queue_id FK is added by ALTER TABLE at the end of this file:
  -- payer_call_queue is created after payer_calls (forward reference).
  queue_id INTEGER,
  caller TEXT NOT NULL DEFAULT 'team'
    CHECK (caller IN ('sara', 'team')),
  outcome TEXT,
  status_answer TEXT,
  reference_number TEXT,
  next_action TEXT,
  -- Simulation label: true until Twilio live calling is connected.
  is_simulated BOOLEAN NOT NULL DEFAULT TRUE,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payer_calls_claim ON payer_calls(claim_id);

CREATE TABLE IF NOT EXISTS payer_call_queue (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  question TEXT NOT NULL, -- the exact question to ask the payer
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_queue_status ON payer_call_queue(status);

CREATE TABLE IF NOT EXISTS appeal_drafts (
  id SERIAL PRIMARY KEY,
  denial_id INTEGER NOT NULL REFERENCES denials(id) ON DELETE RESTRICT,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
  payer TEXT,
  template TEXT, -- e.g. 'aetna-co-97'
  draft_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'filed')),
  -- Deleting a draft never deletes the denial. Marking filed -> denial 'appealing'.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appeal_drafts_denial ON appeal_drafts(denial_id);

CREATE TABLE IF NOT EXISTS era_lines (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  -- Matched claim, or NULL while unmatched (manual match later).
  claim_id INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  payer_claim_number TEXT,
  patient_initials TEXT,
  date_of_service DATE,
  cpt_code TEXT,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('unmatched', 'matched', 'posted')),
  raw_ref TEXT, -- ERA / 835 trace reference
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at, no delete path: ERA lines are financial records.
);
CREATE INDEX IF NOT EXISTS idx_era_lines_status ON era_lines(status);
CREATE INDEX IF NOT EXISTS idx_era_lines_payer_number ON era_lines(payer_claim_number);

-- Deferred foreign keys (tables referenced before they are created above).
-- Claim delete unlinks the session so it can be billed again.
-- (all-migrations.sql adjustment: guarded so a re-run does not error.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_claim') THEN
    ALTER TABLE sessions ADD CONSTRAINT fk_sessions_claim
      FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE SET NULL;
  END IF;
END $$;
-- (all-migrations.sql adjustment: guarded so a re-run does not error.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payer_calls_queue') THEN
    ALTER TABLE payer_calls ADD CONSTRAINT fk_payer_calls_queue
      FOREIGN KEY (queue_id) REFERENCES payer_call_queue(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ==================== 003_platform.sql ====================
-- 003_platform.sql — audit log, automation, alert emails, vendor connections
-- Zenvy Digitals Billing Platform.
--
-- App-layer rules:
--   * audit_log is APPEND-ONLY: the API never exposes update/delete for it,
--     and every write action records who did what (actor, role, clinic,
--     entity, action, detail). A DB-level trigger blocking UPDATE/DELETE is
--     a hardening step for a later pass (kept out so migrations stay
--     runnable in the pg-mem smoke test, which has no trigger support).
--   * connections.mode 'live' is REFUSED until the real vendor account,
--     credentials and approvals exist — the platform never presents a
--     connection as live when it is not.

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'biller', 'viewer')),
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
  entity TEXT NOT NULL, -- e.g. 'claim', 'clinic', 'patient'
  entity_id INTEGER,
  action TEXT NOT NULL, -- e.g. 'create', 'update', 'submit', 'delete', 'login'
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit_log(clinic_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS automation_rules (
  id SERIAL PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE
    CHECK (rule_key IN ('eligibility_checks', 'auth_scan', 'followup_scan', 'call_runner', 'alert_digest')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the 5 automation rules (owner can toggle each on/off).
INSERT INTO automation_rules (rule_key, enabled) VALUES
  ('eligibility_checks', TRUE),
  ('auth_scan', TRUE),
  ('followup_scan', TRUE),
  ('call_runner', TRUE),
  ('alert_digest', TRUE)
ON CONFLICT (rule_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS automation_runs (
  id SERIAL PRIMARY KEY,
  rule_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result JSONB NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_rule ON automation_runs(rule_key);

CREATE TABLE IF NOT EXISTS alert_emails (
  id SERIAL PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  items JSONB NOT NULL DEFAULT '[]', -- auth expiries <= 30d, appeal deadlines <= 14d
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed')),
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_emails_clinic_date ON alert_emails(clinic_id, digest_date);

CREATE TABLE IF NOT EXISTS connections (
  id SERIAL PRIMARY KEY,
  vendor TEXT NOT NULL UNIQUE
    CHECK (vendor IN ('centralreach', 'rethink', 'catalyst', 'availity', 'office_ally', 'waystar', 'twilio')),
  mode TEXT NOT NULL DEFAULT 'off'
    CHECK (mode IN ('off', 'simulation', 'live')),
  notes TEXT, -- exact authorization steps the clinic must complete
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the 7 vendor connections in Simulation mode (honest default until
-- real vendor accounts/approvals exist).
INSERT INTO connections (vendor, mode) VALUES
  ('centralreach', 'simulation'),
  ('rethink', 'simulation'),
  ('catalyst', 'simulation'),
  ('availity', 'simulation'),
  ('office_ally', 'simulation'),
  ('waystar', 'simulation'),
  ('twilio', 'simulation')
ON CONFLICT (vendor) DO NOTHING;

-- ==================== 004_pass3.sql ====================
-- 004_pass3.sql — Paddle references on clinics (Pass 3: subscriptions).
--
-- No new tables: clinics already carry subscription_status / subscription_plan /
-- trial_ends_at (001), and alert_emails / automation_rules / automation_runs
-- already exist (003). This pass only adds the Paddle identifiers so a
-- webhook can map a Paddle subscription back to its clinic.
-- One digest per clinic per day is enforced in code (check-then-insert);
-- the sweep runs once a day, so no unique index is needed.

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT;

-- ==================== 005_pass4.sql ====================
-- 005_pass4.sql — audit-log hardening (REAL POSTGRES ONLY).
-- REAL-POSTGRES-ONLY: pg-mem (the in-memory test database) cannot run
-- CREATE FUNCTION with LANGUAGE plpgsql or CREATE TRIGGER, so the test
-- harness skips this file (see src/migrate.js — it skips files carrying
-- this marker when NODE_ENV is 'test' — and test/migrations.test.js,
-- which asserts the trigger DDL is present instead of executing it).
-- On real Postgres (Supabase at deploy) this file applies normally at
-- startup like every other migration. The trigger makes audit_log
-- append-only at the DATABASE level: any UPDATE, DELETE or TRUNCATE
-- raises an exception, so no code path — and no direct SQL access —
-- can ever rewrite history. The API already exposes no update/delete
-- route for audit_log; this is the second lock on the same door.
-- FIRST LIVE VERIFICATION: run on Supabase at deploy (no real Postgres
-- exists on the build VM to verify against yet).

CREATE OR REPLACE FUNCTION forbid_audit_log_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — audit records cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_change();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_log_change();

-- ==================== 006_pass5.sql ====================
-- 006_pass5.sql — clinic-scoped owner role ('clinic') for public trial signup.
-- Pass 5 adds a public 7-day free trial: a clinic signs up from the
-- website's Subscribe button, and the server creates their clinic plus a
-- clinic-scoped owner account (role 'clinic', clinic_id = their clinic).
-- The users.clinic_id column already exists (001_core.sql) — the ADD
-- COLUMN below is a guarded no-op. The role CHECK is widened: the old
-- constraint (owner/biller/viewer) would reject 'clinic' inserts with
-- a 23514 error. Two DROP statements, because the two engines name the
-- original inline CHECK differently: real Postgres calls it
-- users_role_check (its <table>_<column>_check convention), while
-- pg-mem (test only) calls it users_constraint_1. Each DROP is IF
-- EXISTS, so on real Postgres the pg-mem name is a harmless no-op.
-- The audit log records the actor's role too, so its actor_role CHECK
-- gets the same widening (audit_log_actor_role_check on real Postgres,
-- audit_log_constraint_1 in pg-mem).

ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_constraint_1;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'biller', 'viewer', 'clinic'));

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_role_check;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_constraint_1;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_role_check CHECK (actor_role IN ('owner', 'biller', 'viewer', 'clinic'));

-- ==================== schema_migrations bookkeeping ====================
-- Records the 6 files as applied, so `npm run migrate` (Render/local)
-- later skips them instead of re-applying.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (filename) VALUES
  ('001_core.sql'),
  ('002_billing.sql'),
  ('003_platform.sql'),
  ('004_pass3.sql'),
  ('005_pass4.sql'),
  ('006_pass5.sql')
ON CONFLICT (filename) DO NOTHING;
