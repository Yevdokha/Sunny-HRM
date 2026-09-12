BEGIN;
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS password_reset_required boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrm_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO hrm_app;
  END IF;
END $$;
COMMIT;
