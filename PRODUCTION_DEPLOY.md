# Sunny HRM – production deployment

Цей архів не містить демоакаунтів, demo seed, локального compose або секретів.

## Важливо
- Не видаляйте чинний PostgreSQL volume.
- Не використовуйте `docker compose down -v`.
- Збережіть чинний серверний `.env`.
- Перед оновленням зробіть `pg_dump` існуючої БД.
- Міграції запускаються backend автоматично при старті та мають застосовуватися до існуючої БД без очищення даних.

## Типовий запуск
```bash
docker compose up -d --build
```

Після запуску перевірте:
```bash
docker compose ps
curl -i http://127.0.0.1:3000/api/health
```

Очікувано `/api/health` повертає `ok: true` і `db: connected`.
