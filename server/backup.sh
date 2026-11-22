#!/usr/bin/env bash
# Nightly backup of the Inbox server: the database plus settings, keys and the
# bridges' own files. Keeps the last 7 in server/backups/.
#
#   ./backup.sh             make a backup now
#   ./backup.sh --install   run it every night at 04:17 (cron)
#
# To keep copies off the server too, pull server/backups/ from another
# machine (the README's "Backups" section shows how).
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--install" ]; then
  command -v crontab >/dev/null || { echo "cron isn't installed, so no nightly backup was scheduled (apt-get install cron)."; exit 0; }
  line="17 4 * * * cd $(pwd) && ./backup.sh >> backups/backup.log 2>&1"
  mkdir -p backups
  ( crontab -l 2>/dev/null | grep -v 'inbox.*backup.sh\|/backup.sh' || true; echo "$line" ) | crontab -
  echo "Nightly backup installed (04:17). Backups go to $(pwd)/backups/"
  exit 0
fi

mkdir -p backups
stamp=$(date +%Y-%m-%d_%H%M)
out="backups/inbox-$stamp.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

docker compose exec -T postgres pg_dumpall -U synapse --clean --if-exists | gzip > "$tmp/inbox-db.sql.gz"
# media is large and mostly re-downloadable; keep settings, keys and bridge files
COPYFILE_DISABLE=1 tar czf "$out" --exclude 'data/synapse/media_store' -C "$tmp" inbox-db.sql.gz -C "$(pwd)" .env data
chmod 600 "$out"
ls -1t backups/inbox-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "$(date '+%F %T') backup ok: $out ($(du -h "$out" | cut -f1))"
