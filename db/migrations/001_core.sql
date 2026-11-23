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
