#!/usr/bin/env bash
# Sync your phone book (iCloud contacts via BlueBubbles) to the app.
#
#   ./contacts.sh             sync now
#   ./contacts.sh --install   sync every 15 minutes (cron)
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--install" ]; then
  command -v crontab >/dev/null || { echo "cron isn't installed, so contacts won't sync automatically (apt-get install cron)."; exit 0; }
  line="*/15 * * * * cd $(pwd) && ./contacts.sh >> data/contacts.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v '/contacts.sh' || true; echo "$line" ) | crontab -
  echo "Contacts sync installed (every 15 minutes)."
  exit 0
fi

set -a; . ./.env; set +a
[ -n "${BLUEBUBBLES_PASSWORD:-}" ] || { echo "No BLUEBUBBLES_PASSWORD in .env, so there are no contacts to sync."; exit 0; }
AS_TOKEN=$(sed -n 's/^as_token: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' data/synapse/doublepuppet.yaml)
docker run --rm --network inbox_default --add-host host.docker.internal:host-gateway \
  -v "$PWD:/work" -e BLUEBUBBLES_URL -e BLUEBUBBLES_PASSWORD \
  -e USER_ID="@$ADMIN_USER:$SERVER_NAME" -e AS_TOKEN="$AS_TOKEN" \
  python:3-alpine python /work/contacts.py
