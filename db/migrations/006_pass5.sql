-- 006_pass5.sql — clinic-scoped owner role ('clinic') for public trial signup.
--
-- Pass 5 adds a public 7-day free trial: a clinic signs up from the
-- website's Subscribe button, and the server creates their clinic plus a
-- clinic-scoped owner account (role 'clinic', clinic_id = their clinic).
-- Platform owners keep clinic_id NULL and see everything; a 'clinic' user
-- sees and manages ONLY their own clinic (enforced server-side by
-- loadClinic + the role checks in src/middleware.js).
--
-- The users.clinic_id column already exists (001_core.sql) — the ADD
-- COLUMN below is a guarded no-op so this file is safe to re-run on a
-- database that already has it (e.g. the live Supabase DB, where
-- db/all-migrations.sql was already applied once).
-- The role CHECK is widened: the old constraint (owner/biller/viewer)
-- would reject 'clinic' inserts on real Postgres with a 23514 error.
-- Two DROP statements, because the two engines name the original inline
-- CHECK differently: real Postgres calls it users_role_check (its
-- <table>_<column>_check convention), while pg-mem (test only) calls it
-- users_constraint_1. Each DROP is IF EXISTS, so on either engine the
-- name that does not exist is a harmless no-op.

ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_constraint_1;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'biller', 'viewer', 'clinic'));

-- The audit log records the actor's role too (003_platform.sql), so its
-- actor_role CHECK needs the same widening — otherwise every write a
-- 'clinic' user makes would fail on the audit insert. Same two-name
-- DROP as above (audit_log_actor_role_check on real Postgres,
-- audit_log_constraint_1 in pg-mem).
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_role_check;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_constraint_1;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_role_check CHECK (actor_role IN ('owner', 'biller', 'viewer', 'clinic'));
