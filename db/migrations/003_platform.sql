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
