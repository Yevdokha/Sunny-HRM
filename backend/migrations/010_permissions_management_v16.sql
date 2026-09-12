BEGIN;

ALTER TYPE employee_role ADD VALUE IF NOT EXISTS 'management';

CREATE TABLE IF NOT EXISTS employee_permissions (
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  section text NOT NULL,
  access_level text NOT NULL DEFAULT 'none' CHECK (access_level IN ('none','view','edit','full')),
  updated_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, section)
);

CREATE INDEX IF NOT EXISTS employee_permissions_employee_idx ON employee_permissions(employee_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_permissions TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
COMMIT;
