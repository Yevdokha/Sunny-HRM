BEGIN;

-- Поєднана роль для співробітників, які одночасно є HR і керівниками.
ALTER TYPE employee_role ADD VALUE IF NOT EXISTS 'hr_manager';

-- Баланс відпустки може бути від'ємним, якщо дні використані наперед.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_vacation_days_check;
ALTER TABLE employees ADD CONSTRAINT employees_vacation_days_check
  CHECK (vacation_days BETWEEN -365 AND 365);

-- Після відхилення подальші етапи не мають лишатися «в очікуванні».
ALTER TYPE approval_decision ADD VALUE IF NOT EXISTS 'skipped';

-- Захист від повторного надсилання однакових нагадувань про випробувальний строк.
CREATE TABLE IF NOT EXISTS probation_notifications (
  id              bigserial PRIMARY KEY,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  prob_end        date NOT NULL,
  notice_days     integer NOT NULL DEFAULT 10,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, recipient_email, prob_end, notice_days)
);

-- Оновлюємо RLS для поєднаної ролі.
DROP POLICY IF EXISTS requests_select ON requests;
CREATE POLICY requests_select ON requests FOR SELECT USING (
  employee_id = app_emp()
  OR app_role() IN ('hr','hr_manager','accountant','admin')
  OR EXISTS (SELECT 1 FROM employees e WHERE e.id = requests.employee_id AND e.manager_id = app_emp())
);

DROP POLICY IF EXISTS requests_update ON requests;
CREATE POLICY requests_update ON requests FOR UPDATE USING (
  app_role() IN ('hr','hr_manager','accountant','admin')
  OR EXISTS (SELECT 1 FROM employees e WHERE e.id = requests.employee_id AND e.manager_id = app_emp())
);

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrm_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON probation_notifications TO hrm_app;
    GRANT USAGE, SELECT ON SEQUENCE probation_notifications_id_seq TO hrm_app;
  END IF;
END $$;

COMMIT;
