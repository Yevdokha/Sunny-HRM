-- ============================================================================
-- Sunny Ukraine HRM — Частина 1: схема бази даних (міграція 001, початкова)
-- PostgreSQL 15+
-- Застосовується ОДИН раз. Наступні зміни структури — тільки новими міграціями
-- (002_*.sql, 003_*.sql ...), які ДОДАЮТЬ поля/таблиці, а не перестворюють наявні.
-- Дані ніколи не стираються оновленням коду — вони живуть у Docker volume.
-- ============================================================================

BEGIN;

-- gen_random_uuid() для первинних ключів
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------ ENUM-и ---
CREATE TYPE employee_role     AS ENUM ('user','manager','hr','accountant','admin');
CREATE TYPE activation_status AS ENUM ('invited','active');
CREATE TYPE presence_status   AS ENUM ('none','remote','sick');      -- 🌴 vacation НЕ зберігаємо: derive-иться із затверджених заяв
CREATE TYPE request_type      AS ENUM ('annual','unpaid');           -- Основна щорічна / За власний рахунок
CREATE TYPE request_status    AS ENUM ('pending','approved','rejected');
CREATE TYPE approval_stage    AS ENUM ('manager','hr','accounting');
CREATE TYPE approval_decision AS ENUM ('pending','approved','rejected');

-- автооновлення updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ============================================================ EMPLOYEES ======
CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL,
  email             text        NOT NULL,                 -- завжди в нижньому регістрі (нормалізує бекенд)
  pos               text        NOT NULL DEFAULT '—',     -- управлінська посада (для картки)
  pos_official      text        NOT NULL DEFAULT '—',     -- регламентна/офіційна (для документів)
  dept              text        NOT NULL DEFAULT '—',
  manager_id        uuid        REFERENCES employees(id) ON DELETE SET NULL,
  bday              date,
  hire_date         date        NOT NULL DEFAULT current_date,
  prob_end          date,                                  -- кінець випробувального
  term_date         date,                                  -- деактивація/звільнення (NULL = активний)
  vacation_days     integer     NOT NULL DEFAULT 24 CHECK (vacation_days >= 0), -- ІНДИВІДУАЛЬНИЙ залишок відпустки
  role              employee_role NOT NULL DEFAULT 'user',
  activation        activation_status NOT NULL DEFAULT 'invited',
  password_hash     text,                                  -- bcrypt; NULL поки не активовано / вхід лише через Google
  presence          presence_status NOT NULL DEFAULT 'none',
  photo             text,                                  -- data URL або шлях; великі файли краще в об'єктне сховище (див. README)
  about             text        NOT NULL DEFAULT '',
  failed_logins     integer     NOT NULL DEFAULT 0,        -- для автоблокування
  locked_until      timestamptz,                           -- NULL = не заблоковано
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- пошта унікальна незалежно від регістру
CREATE UNIQUE INDEX employees_email_key ON employees (lower(email));
CREATE INDEX employees_manager_idx ON employees (manager_id);
CREATE INDEX employees_active_idx  ON employees (term_date) WHERE term_date IS NULL;
CREATE TRIGGER trg_employees_updated BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Пошта не обмежена одним доменом: самореєстрація дозволяє будь-яку коректну
-- адресу (напр. звичайну @gmail.com). Унікальність (без урахування регістру)
-- лишається — вище, employees_email_key.

-- ========================================= ЗАПРОШЕННЯ / АКТИВАЦІЯ / СКИДАННЯ ==
-- Одноразові токени: лист-запрошення (активація) та «Забули пароль?».
CREATE TABLE auth_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash   text NOT NULL,                              -- зберігаємо ХЕШ токена, не сам токен
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_emp_idx ON auth_tokens (employee_id, kind);

-- ============================================================ СЕСІЇ ==========
-- httpOnly-cookie сесії (зберігаємо лише хеш токена сесії).
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  ip           inet,                                       -- зберігається, але В ІНТЕРФЕЙСІ НЕ показується
  user_agent   text,                                       -- те саме
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_emp_idx ON sessions (employee_id);

-- ============================================================ ЗАЯВИ ==========
CREATE TABLE requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type          request_type NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  days          integer NOT NULL CHECK (days > 0),         -- календарні дні
  status        request_status NOT NULL DEFAULT 'pending',
  current_stage approval_stage,                            -- на якому етапі зараз (NULL коли завершено)
  submitted_at  date NOT NULL DEFAULT current_date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX requests_emp_idx    ON requests (employee_id);
CREATE INDEX requests_status_idx ON requests (status);
CREATE TRIGGER trg_requests_updated BEFORE UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Заборона накладання дат на вже подані/затверджені відсутності тієї ж людини.
-- Реалізуємо через exclusion-констрейнт (потребує btree_gist).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE requests ADD CONSTRAINT requests_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status <> 'rejected');
-- DEV-REVIEW: якщо потрібно дозволяти накладання різних типів — уточніть правило.

-- ============================================================ ПОГОДЖЕННЯ =====
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage        approval_stage NOT NULL,
  decision     approval_decision NOT NULL DEFAULT 'pending',
  decided_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  comment      text,                                       -- ОБОВ'ЯЗКОВИЙ при відхиленні (перевіряє бекенд)
  decided_at   timestamptz,
  UNIQUE (request_id, stage)
);
CREATE INDEX approvals_req_idx ON approvals (request_id);
-- Не можна погоджувати власну заяву — перевіряє бекенд (див. Частину 2),
-- бо тут потрібна логіка порівняння decided_by з employee_id заяви.

-- ============================================================ НОВИНИ =========
CREATE TABLE news (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ==================================================== ОПИТУВАННЯ / eNPS ======
CREATE TABLE surveys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('enps','poll')),
  question    text NOT NULL,
  options     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE survey_responses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id   uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  value       integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, employee_id)                          -- один голос на людину
);

-- ============================================================ БАЗА ЗНАНЬ =====
CREATE TABLE kb_docs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category     text NOT NULL DEFAULT 'Інше',
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  file_name    text,
  file_mime    text,
  file_data    bytea,                                      -- DEV-REVIEW: великі файли → об'єктне сховище (S3/MinIO), у БД лише посилання
  uploaded_by  uuid REFERENCES employees(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_kb_updated BEFORE UPDATE ON kb_docs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================ РЕКРУТИНГ ======
CREATE TABLE vacancies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  dept       text NOT NULL DEFAULT '—',
  opened_at  date NOT NULL DEFAULT current_date,
  closed_at  date
);
CREATE TABLE candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vacancy_id   uuid REFERENCES vacancies(id) ON DELETE SET NULL,
  name         text NOT NULL,
  email        text,
  phone        text,
  source       text,
  stage        text NOT NULL DEFAULT 'Новий',
  cv_name      text,
  cv_mime      text,
  cv_data      bytea,                                      -- DEV-REVIEW: як і KB — краще об'єктне сховище
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidates_vac_idx ON candidates (vacancy_id);

-- =================================================== ОНБОРДИНГ / ОФБОРДИНГ ===
CREATE TABLE onboarding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid REFERENCES employees(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('onboarding','offboarding')),
  template     text,
  items        jsonb NOT NULL DEFAULT '[]',                -- [{t:"...",done:false}]
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================ ЖУРНАЛ БЕЗПЕКИ / ДІЙ (АУДИТ) ===
-- Спроби входу та алерти. IP/пристрій зберігаємо, але В ІНТЕРФЕЙСІ НЕ показуємо.
CREATE TABLE security_log (
  id          bigserial PRIMARY KEY,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  email       text,
  event_type  text NOT NULL,                               -- login_success | login_fail | logout | locked ...
  reason      text,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_log_email_idx ON security_log (email, created_at);

-- Журнал дій: хто що змінював (розблокування, скидання пароля, деактивація, зміни).
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text,
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================ ПОЧАТКОВИЙ АДМІН (bootstrap) ===
-- ЛИШЕ один системний адміністратор, щоб було під ким увійти й усе налаштувати.
-- Пароль НЕ задаємо тут (жодних форбс2026 у проді): адмін активує акаунт листом,
-- або одразу входить через Google. Усіх інших HR заводить через імпорт/додавання.
-- DEV-REVIEW: підставте реальну пошту адміністратора перед застосуванням.
-- Початковий адміністратор створюється окремою командою bootstrap-admin після міграцій.


-- ================================================ ROW-LEVEL SECURITY (RLS) ===
-- Приватність на рівні БАЗИ: навіть в обхід інтерфейсу не можна дістати чужі рядки.
-- Бекенд на КОЖЕН запит виконує в транзакції:
--     SET LOCAL app.employee_id = '<uuid залогіненого>';
--     SET LOCAL app.role        = '<роль>';
-- і працює під роллю БД, для якої RLS увімкнено (НЕ суперюзер, НЕ власник таблиць).
--
-- Нижче — флагманський приклад на таблиці requests (заяви). Аналогічно розширюємо
-- на решту чутливих таблиць у наступних міграціях. DEV-REVIEW перед продом ОБОВ'ЯЗКОВО.

ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests FORCE ROW LEVEL SECURITY;

-- helper-и, що читають контекст поточного запиту
CREATE OR REPLACE FUNCTION app_emp() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.employee_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION app_role() RETURNS text AS $$
  SELECT coalesce(nullif(current_setting('app.role', true), ''), 'user');
$$ LANGUAGE sql STABLE;

-- Хто може ЧИТАТИ заяву: автор; його керівник; hr/accountant/admin — усі.
CREATE POLICY requests_select ON requests FOR SELECT USING (
  employee_id = app_emp()
  OR app_role() IN ('hr','accountant','admin')
  OR EXISTS (SELECT 1 FROM employees e WHERE e.id = requests.employee_id AND e.manager_id = app_emp())
);
-- Створювати заяву можна лише собі.
CREATE POLICY requests_insert ON requests FOR INSERT WITH CHECK (employee_id = app_emp());
-- Оновлювати (рух статусів) — hr/accountant/admin або керівник автора; автор не змінює рішення.
CREATE POLICY requests_update ON requests FOR UPDATE USING (
  app_role() IN ('hr','accountant','admin')
  OR EXISTS (SELECT 1 FROM employees e WHERE e.id = requests.employee_id AND e.manager_id = app_emp())
);

-- Примітка: приховування ОКРЕМИХ колонок (рік народження, зарплата) — це
-- column-level privacy; його зручніше робити через окремі VIEW + логіку API
-- (RLS ховає РЯДКИ, а не колонки). Закладемо у Частині 2.

-- Права для НЕсуперюзерної ролі застосунку (hrm_app), під якою ходить бекенд.
-- Роль створює init-скрипт БД (db/init/00_app_role.sh) при першому старті.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hrm_app') THEN
    GRANT USAGE ON SCHEMA public TO hrm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrm_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
    GRANT EXECUTE ON FUNCTION app_emp(), app_role() TO hrm_app;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- DEV-REVIEW перед продом (стисло):
--   1) Реальна пошта bootstrap-адміна (не залишати admin@sunny.ua «як є»).
--   2) RLS: створити роль БД для застосунку БЕЗ BYPASSRLS; переконатися, що
--      бекенд ходить саме під нею, і що SET LOCAL app.* виставляється в КОЖНІЙ
--      транзакції до будь-яких запитів.
--   3) Розширити RLS-політики на employees (з урахуванням column-privacy через view),
--      approvals, survey_responses, security_log, audit_log.
--   4) Вирішити, де зберігати файли (фото, CV, KB): у проді — об'єктне сховище.
--   5) Перевірити правило заборони накладання дат під ваші реальні кейси.
-- ============================================================================
