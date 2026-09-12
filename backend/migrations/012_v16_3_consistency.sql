BEGIN;

-- Випробувальний строк: для наявних активних профілів без дати заповнюємо автоматично.
-- Базове правило відповідає імпорту: 3 місяці, для керівних ролей — 6 місяців.
UPDATE employees
SET prob_end = (hire_date + CASE WHEN role IN ('manager','management','hr_manager')
                                 THEN interval '6 months' ELSE interval '3 months' END)::date
WHERE prob_end IS NULL AND hire_date IS NOT NULL AND term_date IS NULL;

-- «Видача прав» є захищеним модулем: доступ лише HR / Керівник-HR / Адміністратор.
INSERT INTO employee_permissions(employee_id,section,access_level,updated_by)
SELECT id,'permissions',CASE WHEN role IN ('hr','hr_manager','admin') THEN 'full' ELSE 'none' END,NULL
FROM employees
ON CONFLICT(employee_id,section) DO UPDATE
SET access_level=EXCLUDED.access_level, updated_by=NULL, updated_at=now();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_permissions TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
COMMIT;
