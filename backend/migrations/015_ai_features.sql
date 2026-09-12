BEGIN;

-- Опис/вимоги вакансії — потрібен, щоб ШІ мав із чим звірити резюме кандидата.
ALTER TABLE vacancies ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- Останній ШІ-розбір резюме кандидата (зберігаємо, щоб не генерувати повторно
-- щоразу при відкритті картки; HR може оновити вручну кнопкою «Оновити оцінку»).
-- Права доступу на самі таблиці vacancies/candidates вже надані в 001_init.sql —
-- нові колонки додаткового GRANT не потребують.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ai_review text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ai_reviewed_at timestamptz;

COMMIT;
