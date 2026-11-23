-- 004_pass3.sql — Paddle references on clinics (Pass 3: subscriptions).
--
-- No new tables: clinics already carry subscription_status / subscription_plan /
-- trial_ends_at (001), and alert_emails / automation_rules / automation_runs
-- already exist (003). This pass only adds the Paddle identifiers so a
-- webhook can map a Paddle subscription back to its clinic.
-- One digest per clinic per day is enforced in code (check-then-insert);
-- the sweep runs once a day, so no unique index is needed.

ALTER TABLE clinics ADD COLUMN paddle_customer_id TEXT;
ALTER TABLE clinics ADD COLUMN paddle_subscription_id TEXT;
