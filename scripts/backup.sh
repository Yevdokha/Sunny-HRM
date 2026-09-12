#!/bin/sh
set -eu
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/backups/sunny-hrm-${APP_ENV:-production}-${TS}.sql.gz"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h db -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip -9 > "$OUT"
find /backups -type f -name 'sunny-hrm-*.sql.gz' -mtime +"${BACKUP_RETENTION_DAYS:-30}" -delete
printf '%s\n' "$OUT"
