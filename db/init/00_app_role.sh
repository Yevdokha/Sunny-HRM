#!/bin/bash
# Виконується ОДИН раз при першій ініціалізації БД (як суперюзер).
# Створює НЕсуперюзерну роль застосунку — саме під нею працює бекенд,
# тому до неї застосовується Row-Level Security (суперюзер RLS обходить).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
SQL
