#!/usr/bin/env bash
# WhatsApp often hides people's numbers behind "linked IDs" (ghosts like @whatsapp_lid-123…),
# so Inbox couldn't match those chats to contact cards or to the same person on other apps.
# The WhatsApp bridge knows the real numbers (whatsmeow_lid_map). This publishes them to
# account data fit.simas.inbox.lidmap {map: {lid: number}} for the app; only when changed.
#
# Usage (in /root/server): bash lidmap.sh            publish once
#                          bash lidmap.sh --install  every 30 minutes (cron; setup.sh does this)
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--install" ]]; then
  line="*/30 * * * * cd $PWD && bash lidmap.sh >> data/lidmap.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'lidmap.sh' ; echo "$line" ) | crontab -
  echo "Installed: $line"
  exit 0
fi

val() { sed -n "s/^$1=//p" .env | tail -1 | tr -d '"'"'"; }
USER_ID="@$(val ADMIN_USER):$(val SERVER_NAME)"
TOKEN=$(sed -n 's/^as_token: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' data/synapse/doublepuppet.yaml)
json=$(docker compose exec -T postgres psql -U synapse -d whatsapp -tA -c \
  "select coalesce(json_build_object('map', json_object_agg(split_part(lid,'@',1), split_part(pn,'@',1))), '{\"map\":{}}') from whatsmeow_lid_map where pn <> ''")
sum=$(printf '%s' "$json" | sha256sum | cut -c1-16)
[[ -f data/lidmap.sum && "$(cat data/lidmap.sum)" == "$sum" ]] && exit 0
uid=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$USER_ID")
code=$(printf '%s' "$json" | curl -s -o /dev/null -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:8008/_matrix/client/v3/user/$uid/account_data/fit.simas.inbox.lidmap?user_id=$uid")
if [[ "$code" == 200 ]]; then echo "$sum" > data/lidmap.sum; echo "$(date -Is) published $(printf '%s' "$json" | grep -o ':' | wc -l) numbers"; else echo "$(date -Is) failed: HTTP $code"; fi
