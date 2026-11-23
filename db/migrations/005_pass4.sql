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
