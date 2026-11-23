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
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_claim
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE SET NULL;
ALTER TABLE payer_calls ADD CONSTRAINT fk_payer_calls_queue
  FOREIGN KEY (queue_id) REFERENCES payer_call_queue(id) ON DELETE SET NULL;
