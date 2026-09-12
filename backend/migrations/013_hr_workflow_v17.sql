BEGIN;

-- Персональні/ідентифікаційні дані. Зміст читається лише через прикладні endpoint-и
-- з додатковою перевіркою ролі HR або власника профілю.
CREATE TABLE IF NOT EXISTS employee_personal_data (
  employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  sex text CHECK (sex IN ('male','female')),
  passport_type text CHECK (passport_type IN ('booklet','id_card','residence_permit')),
  passport_series text,
  passport_number text,
  passport_issue_date date,
  passport_issuer text,
  tax_id text,
  updated_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_employee_personal_data_updated BEFORE UPDATE ON employee_personal_data
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Нарахування/коригування відпустки: журнал пояснює кожну зміну балансу.
CREATE TABLE IF NOT EXISTS vacation_accruals (
  id bigserial PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  accrual_date date NOT NULL DEFAULT current_date,
  days integer NOT NULL CHECK (days BETWEEN -365 AND 365 AND days <> 0),
  source text NOT NULL CHECK (source IN ('automatic','manual','request')),
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vacation_accruals_emp_idx ON vacation_accruals(employee_id, accrual_date DESC, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS vacation_accruals_auto_once
  ON vacation_accruals(employee_id, accrual_date, source) WHERE source='automatic';

-- Для наявних співробітників не перераховуємо старий баланс заднім числом.
-- Новим профілям backend встановлює старт на дату найму.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS vacation_accrual_start date NOT NULL DEFAULT current_date;
-- Чинний баланс на момент оновлення вважаємо стартовим: не нараховуємо повторно день міграції.
UPDATE employees SET vacation_accrual_start=current_date + 1 WHERE vacation_accrual_start=current_date;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS invite_sent_at timestamptz;

-- М'яке видалення процесів онбордингу/офбордингу.
ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES employees(id) ON DELETE SET NULL;

-- Простий довідник корпоративних сервісів для онбордингу.
CREATE TABLE IF NOT EXISTS company_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_services_name_key ON company_services(lower(name));
CREATE TRIGGER trg_company_services_updated BEFORE UPDATE ON company_services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrm_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON employee_personal_data TO hrm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON vacation_accruals TO hrm_app;
    GRANT USAGE, SELECT ON SEQUENCE vacation_accruals_id_seq TO hrm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON company_services TO hrm_app;
  END IF;
END $$;

COMMIT;
