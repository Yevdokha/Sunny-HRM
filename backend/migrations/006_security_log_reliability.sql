BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON security_log, audit_log, security_alerts, system_checks TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
CREATE INDEX IF NOT EXISTS security_log_created_idx ON security_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
COMMIT;
