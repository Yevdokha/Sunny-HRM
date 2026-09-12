# Sunny HRM — опис API (відкриті, задокументовані endpoint-и)

Базовий префікс: `/api`. Авторизація — httpOnly-cookie сесія (після входу).
Формат — JSON (крім завантаження файлів — multipart). Кожна дія зберігається в PostgreSQL одразу.
Цей перелік — основа для майбутніх інтеграцій (напр. BAS).

## Авторизація
| Метод | Шлях | Опис |
|---|---|---|
| POST | `/auth/register` | самореєстрація (`name`,`email`,`password`); будь-яка коректна пошта |
| POST | `/auth/google` | вхід через Google (тіло: `id_token`); опційно, лише для вже існуючих співробітників |
| POST | `/auth/login` | запасний вхід (`email`,`password`) |
| POST | `/auth/activate` | активація за листом (`token`,`password`) |
| POST | `/auth/forgot` | надіслати лист відновлення (`email`) |
| POST | `/auth/reset` | задати новий пароль (`token`,`password`) |
| POST | `/auth/logout` | вихід |
| GET  | `/auth/me` | поточний користувач |

## Співробітники
| Метод | Шлях | Права | Опис |
|---|---|---|---|
| GET | `/employees` | усі | список (рік народження приховано від не-HR) |
| GET | `/employees/:id` | усі | картка |
| PATCH | `/employees/:id` | сам / HR | редагування (HR — усі поля) |
| POST | `/employees` | HR | додати → статус «Запрошено» + лист |
| POST | `/employees/:id/deactivate` | HR | звільнити (підлеглі — вгору) |
| POST | `/employees/:id/unlock` | HR | розблокувати акаунт |
| POST | `/employees/:id/reinvite` | HR | повторно надіслати запрошення |

## Заяви та погодження
| Метод | Шлях | Опис |
|---|---|---|
| GET | `/requests` | мої заявки / ті, що чекають мого рішення (RLS) |
| POST | `/requests` | подати (`type`: annual\|unpaid, `start_date`,`end_date`); накладання дат блокується |
| POST | `/requests/:id/decide` | рішення (`decision`: approve\|reject, `comment`); reject потребує коментаря; фінальне approve віднімає дні відпустки |

## Контент
| Метод | Шлях | Права |
|---|---|---|
| GET/POST | `/news` | читають усі; публікує керівництво |
| GET/POST | `/surveys`, POST `/surveys/:id/respond` | eNPS/опитування |
| GET `/kb`, GET `/kb/:id/file`, POST `/kb` | база знань (файли) |
| GET/POST `/vacancies`, GET/POST/PATCH `/candidates` | рекрутинг |
| GET `/onboarding` | онбординг (HR/керівники) |

## Імпорт і безпека
| Метод | Шлях | Опис |
|---|---|---|
| POST | `/import/employees` | multipart CSV → upsert за поштою, оргструктура, запрошення |
| GET | `/security/log` | журнал спроб входу (без IP/пристрою) — HR/адмін |
| GET | `/security/alerts` | алерти підозрілої активності — HR/адмін |

---

## Локальний блок заяв — версія 6

### `GET /api/requests`
Повертає:
- власні заяви користувача;
- заяви, які зараз очікують саме його рішення;
- заяви, які він уже опрацьовував.

### `POST /api/requests`
```json
{
  "type": "annual",
  "start_date": "2026-09-14",
  "end_date": "2026-09-18"
}
```
`type`: `annual` або `unpaid`. Перетин дат і недостатній залишок повертають HTTP `409`.

### `POST /api/requests/:id/decide`
```json
{
  "decision": "approve",
  "comment": ""
}
```
`decision`: `approve` або `reject`. Для `reject` коментар обов’язковий.

## Співробітники та профілі — версія 9

### `GET /api/employees`
Активні співробітники з серверною фільтрацією персональних полів відповідно до ролі та зв’язку керівник–підлеглий.

### `GET /api/employees/:id`
Профіль одного співробітника. Рік народження доступний лише власнику та HR.

### `PATCH /api/employees/:id`
Власник змінює дозволені особисті поля. HR змінює також відділ, керівника, роль, дати й залишок відпустки. Сервер перевіряє цикли оргструктури.

### `POST /api/employees`
HR створює співробітника зі статусом `invited`; генерується токен запрошення.

### `POST /api/employees/:id/deactivate`
HR деактивує акаунт. Операція завершує сесії й перепідпорядковує прямих підлеглих рівнем вище.

## Версія 13 — рекрутинг та онбординг

### Вакансії
- `GET /api/vacancies` — список вакансій (HR)
- `POST /api/vacancies` — створення вакансії (HR)
- `PATCH /api/vacancies/:id` — редагування / закриття / повторне відкриття (HR)
- `DELETE /api/vacancies/:id` — видалення порожньої вакансії (HR)

### Кандидати
- `GET /api/candidates` — список кандидатів (HR)
- `POST /api/candidates` — створення кандидата, multipart із CV (HR)
- `PATCH /api/candidates/:id` — редагування або зміна етапу (HR)
- `DELETE /api/candidates/:id` — видалення (HR)
- `GET /api/candidates/:id/file` — перегляд/завантаження CV (HR)

### Онбординг / офбординг
- `GET /api/onboarding` — HR бачить усі, керівник лише своїх прямих підлеглих
- `POST /api/onboarding` — створення процесу
- `PATCH /api/onboarding/:id` — зміна чек-листа та статусів задач
- `DELETE /api/onboarding/:id` — видалення процесу (HR)

### Перегляд файлів бази знань
- `GET /api/kb/:id/render` — серверне перетворення офісних форматів у PDF через LibreOffice
- `GET /api/kb/:id/preview` — текст/код або URL підготовленого PDF

## Історія технічної безпеки (v14.6)

- `GET /api/security/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all&user=&month=YYYY-MM`
  - журнали входу, адміністративні дії, активні алерти, статистика за період і календар місяця;
  - доступ: `admin`.
- `GET /api/security/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all&user=`
  - CSV за обраний період без IP та User-Agent;
  - доступ: `admin`.


## Корпоративний GUID (v17.4)

Доступ: лише ролі HR, HR-керівник та Адміністратор. Поле не входить до стандартних відповідей `/api/employees`.

- `GET /api/employees/:id/corporate-guid` — отримати `is_fop` та `corporate_guid`.
- `POST /api/employees/:id/corporate-guid/generate` — згенерувати новий UUID v4-кандидат без автоматичного збереження.
- `PUT /api/employees/:id/corporate-guid` — зберегти `is_fop` та GUID; дублікати заборонені унікальним індексом БД.

## ШІ-функції (опційно, потребують GEMINI_API_KEY або ANTHROPIC_API_KEY у .env)

- `POST /api/ai/chat` — навігаційний чат-помічник по системі. Тіло: `{"messages":[{"role":"user"|"assistant","content":"..."}]}` (коротка історія діалогу). Доступ: будь-який залогінений користувач.
- `POST /api/candidates/:id/ai-review` — ШІ-оцінка резюме кандидата відносно вакансії (заповнює `ai_review`, `ai_reviewed_at`). Потребує прикріпленого CV у форматі PDF, DOCX або TXT. Доступ: право `recruiting: edit`.

Провайдер обирається автоматично: якщо задано `GEMINI_API_KEY` (безкоштовно, без картки — Google AI Studio) — використовується Gemini; інакше, якщо задано `ANTHROPIC_API_KEY` — Claude. Без жодного з двох ключів обидва endpoint-и повертають `503` з поясненням — решта системи не зачіпається.
