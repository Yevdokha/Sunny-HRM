BEGIN;

-- Корпоративний GUID для зв'язування HRM з іншими корпоративними системами.
-- Для співробітників з BAS GUID вносить HR/Адміністратор вручну.
-- Для ФОП HRM генерує UUID v4 лише після явної дії «Згенерувати».
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_fop boolean;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS corporate_guid uuid;

-- Один GUID не може належати двом співробітникам.
CREATE UNIQUE INDEX IF NOT EXISTS employees_corporate_guid_key
  ON employees (corporate_guid)
  WHERE corporate_guid IS NOT NULL;

COMMIT;
