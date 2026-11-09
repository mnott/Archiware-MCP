#!/bin/bash
# Daily logical dump of archive_catalog for the tape backup; keeps the last 14. Runs inside catalog-dump.
# The cache table is left out (rebuilt from P5 on demand). One dump at start, then one per night at 02:00.
set -o pipefail
KEEP=14
while true; do
  f="/dumps/archive_catalog-$(date +%Y%m%d).sql.gz"
  if MYSQL_PWD="$(cat /secrets/db_catalog_password)" mariadb-dump -h catalog-db -ucatalog --single-transaction --ignore-table=archive_catalog.p5_cache archive_catalog | gzip > "$f.part"; then
    mv "$f.part" "$f"
    echo "$(date '+%F %T') dump ok: $f ($(stat -c %s "$f") bytes)"
  else
    rm -f "$f.part"
    echo "$(date '+%F %T') dump FAILED" >&2
  fi
  ls -1t /dumps/archive_catalog-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  sleep $(( $(date -d 'tomorrow 02:00' +%s) - $(date +%s) ))
done
