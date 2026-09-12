BEGIN;

CREATE TABLE IF NOT EXISTS security_alerts (
  id bigserial PRIMARY KEY,
  alert_key text NOT NULL,
  level text NOT NULL CHECK (level IN ('info','warning','critical')),
  category text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','resolved')),
  source_event_id bigint REFERENCES security_log(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS security_alerts_status_idx ON security_alerts(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS security_alerts_key_unique ON security_alerts(alert_key);

CREATE TABLE IF NOT EXISTS system_checks (
  id bigserial PRIMARY KEY,
  component text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','warning','error')),
  detail text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_checks_component_idx ON system_checks(component, checked_at DESC);

ALTER TABLE security_log ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip inet;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS result text NOT NULL DEFAULT 'success';

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrm_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON security_alerts, system_checks TO hrm_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
  END IF;
END $$;

COMMIT;
