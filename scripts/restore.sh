#!/bin/sh
set -eu
FILE=${1:?Вкажіть шлях до .sql.gz}
case "$FILE" in *.sql.gz) ;; *) echo 'Очікується файл .sql.gz'; exit 1;; esac
printf 'УВАГА: відновлення перезапише дані у %s. Для продовження введіть RESTORE: ' "$POSTGRES_DB"
read ANSWER
[ "$ANSWER" = RESTORE ] || exit 1
zcat "$FILE" | PGPASSWORD="$POSTGRES_PASSWORD" psql -h db -U "$POSTGRES_USER" "$POSTGRES_DB"
