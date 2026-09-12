# Sunny HRM v17.6.3 — оновлення сервера

Цей архів призначений для оновлення чинного серверного HRM без втрати даних.

## Важливо
- НЕ копіюйте локальний `.env` на сервер. Використовуйте чинний серверний `~/sunny-hrm/.env`.
- НЕ використовуйте `docker compose down -v`.
- НЕ видаляйте Docker volume PostgreSQL (`pgdata`).
- Перед оновленням зробіть `pg_dump` чинної БД і копію папки `~/sunny-hrm`.

## Безпечна схема
1. Зробити backup PostgreSQL.
2. Зберегти копію чинної папки HRM.
3. Зберегти чинний `.env` окремо.
4. Замінити backend/frontend/db/scripts/docs і production-файли кодом із цього архіву.
5. Повернути чинний `.env`.
6. Перевірити `docker compose config --quiet`.
7. Запустити `docker compose up -d --build` (або готовий image через `docker load`, якщо сервер не має доступу до Docker Hub).
8. Перевірити `docker compose ps` і `docker compose logs --tail=100 backend`.

Чинні співробітники, заявки та інші дані зберігаються в PostgreSQL volume і не входять до цього ZIP.
