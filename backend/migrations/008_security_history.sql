BEGIN;
CREATE INDEX IF NOT EXISTS security_log_created_at_idx ON security_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS security_alerts_created_at_idx ON security_alerts(created_at DESC);
COMMIT;
