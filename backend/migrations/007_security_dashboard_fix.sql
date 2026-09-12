BEGIN;

ALTER TABLE security_log ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT 'success';

GRANT SELECT, INSERT, UPDATE, DELETE ON security_log, audit_log, security_alerts, system_checks TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;

CREATE INDEX IF NOT EXISTS security_log_event_created_idx ON security_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS security_alerts_employee_idx ON security_alerts(employee_id, created_at DESC);

COMMIT;
