#!/usr/bin/env bash
# One-time setup for the Inbox server. Safe to re-run: it only creates what's
# missing and re-applies the settings it owns.
#
#   cp .env.example .env   # fill it in
#   ./setup.sh
#
# Needs only Docker (with the compose plugin). Works on Linux and macOS.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker isn't installed."
docker compose version >/dev/null 2>&1 || die "The Docker compose plugin isn't installed."
[ -f .env ] || { cp .env.example .env; die "Created .env. Fill it in, then run ./setup.sh again."; }

set -a; . ./.env; set +a
: "${SERVER_NAME:?set SERVER_NAME in .env}" "${MATRIX_HOST:?set MATRIX_HOST in .env}" "${ADMIN_USER:?set ADMIN_USER in .env}"
BRIDGES=${BRIDGES-whatsapp telegram facebook instagram imessage}
SYNAPSE_IMAGE=${SYNAPSE_IMAGE:-matrixdotorg/synapse:latest}

rand() { openssl rand -hex 24 2>/dev/null || LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 48; }
setenv() {  # write KEY=VALUE into .env (replacing any existing line)
  if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else echo "$1=$2" >>.env; fi
}

if [ -z "${POSTGRES_PASSWORD:-}" ]; then POSTGRES_PASSWORD=$(rand); setenv POSTGRES_PASSWORD "$POSTGRES_PASSWORD"; fi
if [[ " $BRIDGES " == *" telegram "* ]] && [ -z "${TELEGRAM_API_ID:-}" ]; then
  echo "TELEGRAM_API_ID is empty, so Telegram is skipped for now (get keys at https://my.telegram.org/apps)."
  BRIDGES=$(echo " $BRIDGES " | sed 's/ telegram / /' | xargs)
fi
if [[ " $BRIDGES " == *" imessage "* ]] && [ -z "${BLUEBUBBLES_PASSWORD:-}" ]; then
  echo "BLUEBUBBLES_PASSWORD is empty, so iMessage is skipped for now (see README: iMessage)."
  BRIDGES=$(echo " $BRIDGES " | sed 's/ imessage / /' | xargs)
fi
BLUEBUBBLES_URL=${BLUEBUBBLES_URL:-http://host.docker.internal:1234}
export BLUEBUBBLES_URL
profiles=$BRIDGES
[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && profiles="$profiles tunnel"
# your phone book for the app: iCloud contacts (or BlueBubbles on the Mac as a fallback)
if [ -n "${ICLOUD_USER:-}" ] && [ -n "${ICLOUD_APP_PASSWORD:-}" ] || [ -n "${BLUEBUBBLES_PASSWORD:-}" ]; then profiles="$profiles contacts"; fi
# reply suggestions in his style, from a small open-source model on this server (SUGGEST=1 in .env)
if [ "${SUGGEST:-}" = 1 ]; then profiles="$profiles suggest"; fi
COMPOSE_PROFILES=$(echo $profiles | tr ' ' ',')
setenv COMPOSE_PROFILES "$COMPOSE_PROFILES"
export COMPOSE_PROFILES POSTGRES_PASSWORD

DATA="$PWD/data"
mkdir -p "$DATA/synapse" "$DATA/contacts"
# Helpers that run inside containers, so file ownership never gets in the way.
yq() { docker run --rm -i --user root -v "$DATA:/data" -e SERVER_NAME -e MATRIX_HOST -e ADMIN_USER -e POSTGRES_PASSWORD -e DP_TOKEN -e TELEGRAM_API_ID -e TELEGRAM_API_HASH -e BLUEBUBBLES_URL -e BLUEBUBBLES_PASSWORD -e ADMIN_REGEX -e VAPID_PUBLIC_KEY mikefarah/yq:4 "$@"; }
inside() { docker run --rm -i -v "$DATA:/data" alpine:3 sh -c "$1"; }

# --- Synapse ---------------------------------------------------------------
if [ ! -f "$DATA/synapse/homeserver.yaml" ]; then
  say "Generating the Matrix server config for $SERVER_NAME"
  docker run --rm -v "$DATA/synapse:/data" -e SYNAPSE_SERVER_NAME="$SERVER_NAME" -e SYNAPSE_REPORT_STATS=no "$SYNAPSE_IMAGE" generate
fi

# Double puppeting: lets each bridge show messages you send from your phone as
# coming from you (instead of from a "ghost" of you).
if [ ! -f "$DATA/synapse/doublepuppet.yaml" ]; then
  cat <<EOF | inside 'cat > /data/synapse/doublepuppet.yaml && chmod 644 /data/synapse/doublepuppet.yaml'
id: doublepuppet
url: null
as_token: "$(rand)"
hs_token: "$(rand)"
sender_localpart: "$(rand)"
rate_limited: false
namespaces:
  users:
    - regex: '@.*:$(printf '%s' "$SERVER_NAME" | sed 's/\./\\./g')'
      exclusive: false
EOF
fi
DP_TOKEN=$(yq '.as_token' /data/synapse/doublepuppet.yaml)
export DP_TOKEN

# --- Bridges ---------------------------------------------------------------
regs='"/data/doublepuppet.yaml"'
port_of() { case $1 in whatsapp) echo 29318 ;; telegram) echo 29317 ;; facebook) echo 29319 ;; instagram) echo 29330 ;; imessage) echo 29331 ;; esac; }
image_of() {
  case $1 in
    whatsapp) echo "${WHATSAPP_IMAGE:-dock.mau.dev/mautrix/whatsapp:latest}" ;;
    telegram) echo "${TELEGRAM_IMAGE:-dock.mau.dev/mautrix/telegram:latest}" ;;
    facebook) echo "${META_IMAGE:-dock.mau.dev/mautrix/meta:latest}" ;;
    instagram) echo "${INSTAGRAM_IMAGE:-dock.mau.dev/mautrix/meta:ig-latest}" ;;
    imessage) echo "${IMESSAGE_IMAGE:-dock.mau.dev/mautrix/imessage:latest}" ;;
  esac
}
extra_of() {
  case $1 in
    # ask the phone for a year of history instead of three months
    # and name people as you saved them in your phone, without the default " (WA)" tag
    whatsapp) echo '| .network.history_sync.request_full_sync = true | .network.displayname_template = "{{or .FullName .BusinessName .PushName .Phone .RedactedPhone \"Unknown user\"}}"' ;;
    telegram) echo '| .network.api_id = env(TELEGRAM_API_ID) | .network.api_hash = strenv(TELEGRAM_API_HASH)' ;;
    # most Messenger 1:1 chats are end-to-end encrypted; their history only comes
    # from Messenger's encrypted backup, which the bridge restores with your 6-digit PIN
    # and fetch up to 10000 messages per chat (needs sky's patched bridge, see build-meta.sh)
    facebook) echo '| .network.e2ee_backfill = true | .backfill.max_initial_messages = 10000' ;;
    *) echo '' ;;
  esac
}

# WhatsApp, Telegram, Messenger and Instagram share one config layout (mautrix "bridgev2").
bridgev2_config() {
  local b=$1 port=$2
  echo "
    .homeserver.address = \"http://synapse:8008\" |
    .homeserver.domain = strenv(SERVER_NAME) |
    .appservice.address = \"http://$b:$port\" |
    .appservice.hostname = \"0.0.0.0\" |
    .appservice.port = $port |
    .appservice.id = \"$b\" |
    .appservice.bot.username = \"${b}bot\" |
    .appservice.username_template = \"${b}_{{.}}\" |
    .database.type = \"postgres\" |
    .database.uri = \"postgres://synapse:\" + strenv(POSTGRES_PASSWORD) + \"@postgres/$b?sslmode=disable\" |
    .bridge.permissions = {} |
    .bridge.permissions[strenv(SERVER_NAME)] = \"user\" |
    .bridge.permissions[\"@\" + strenv(ADMIN_USER) + \":\" + strenv(SERVER_NAME)] = \"admin\" |
    .bridge.personal_filtering_spaces = false |
    .double_puppet.servers = {} |
    .double_puppet.secrets = {} |
    .double_puppet.secrets[strenv(SERVER_NAME)] = \"as_token:\" + strenv(DP_TOKEN) |
    .encryption.allow = false |
    .matrix.delivery_receipts = true |
    .backfill.enabled = true |
    .backfill.max_initial_messages = 1000
    $(extra_of "$b")"
}

# iMessage uses the older mautrix layout and talks to the BlueBubbles server app on the Mac.
# Its database must be SQLite: the bridge's schema doesn't work on Postgres.
imessage_config() {
  echo '
    .homeserver.address = "http://synapse:8008" |
    .homeserver.websocket_proxy = null |
    .homeserver.domain = strenv(SERVER_NAME) |
    .appservice.address = "http://imessage:29331" |
    .appservice.hostname = "0.0.0.0" |
    .appservice.port = 29331 |
    .appservice.id = "imessage" |
    .appservice.bot.username = "imessagebot" |
    .appservice.database.type = "sqlite3-fk-wal" |
    .appservice.database.uri = "file:/data/mautrix-imessage.db?_txlock=immediate" |
    .imessage.platform = "bluebubbles" |
    .imessage.bluebubbles_url = strenv(BLUEBUBBLES_URL) |
    .imessage.bluebubbles_password = strenv(BLUEBUBBLES_PASSWORD) |
    .bridge.user = "@" + strenv(ADMIN_USER) + ":" + strenv(SERVER_NAME) |
    .bridge.username_template = "imessage_{{.}}" |
    .bridge.displayname_template = "{{.}}" |
    .bridge.login_shared_secret = "as_token:" + strenv(DP_TOKEN) |
    .bridge.personal_filtering_spaces = false |
    .bridge.encryption.allow = false |
    .bridge.delivery_receipts = true |
    .bridge.backfill.enable = true |
    .bridge.backfill.initial_limit = 10000 |
    .bridge.backfill.initial_sync_max_age = 36500'
}

for b in $BRIDGES; do
  port=$(port_of "$b") || true
  [ -n "$port" ] || die "Unknown bridge '$b' in BRIDGES."
  image=$(image_of "$b")
  mkdir -p "$DATA/$b"
  if [ ! -f "$DATA/$b/config.yaml" ]; then
    say "Generating the $b bridge config"
    docker run --rm -v "$DATA/$b:/data" "$image" || true
    [ -f "$DATA/$b/config.yaml" ] || die "The $b bridge didn't create a config file."
  fi
  say "Configuring the $b bridge"
  if [ "$b" = imessage ]; then yq -i "$(imessage_config)" /data/imessage/config.yaml
  else yq -i "$(bridgev2_config "$b" "$port")" "/data/$b/config.yaml"; fi
  if [ ! -f "$DATA/$b/registration.yaml" ]; then
    docker run --rm -v "$DATA/$b:/data" "$image" || true
    [ -f "$DATA/$b/registration.yaml" ] || die "The $b bridge didn't create a registration file."
  fi
  inside "cp /data/$b/registration.yaml /data/synapse/$b-registration.yaml && chmod 644 /data/synapse/$b-registration.yaml"
  if [ "$b" = imessage ]; then
    # lets the iMessage bridge post the messages you send from your iPhone as you
    export ADMIN_REGEX="^@$ADMIN_USER:$(printf '%s' "$SERVER_NAME" | sed 's/\./\\./g')\$"
    # and tells Synapse where the bridge is: this older bridge drops `appservice.address`
    # from its config, so the registration it writes has no URL
    yq -i \
      '.url = "http://imessage:29331" | .namespaces.users += [{"regex": strenv(ADMIN_REGEX), "exclusive": false}] | .namespaces.users |= unique_by(.regex)' \
      /data/synapse/imessage-registration.yaml
  fi
  regs="$regs, \"/data/$b-registration.yaml\""
done

# --- Push notifications -----------------------------------------------------
# Sygnal turns Synapse's notifications into Web Push messages for the app.
SYGNAL_IMAGE=${SYGNAL_IMAGE:-matrixdotorg/sygnal:latest}
mkdir -p "$DATA/sygnal"
if [ ! -f "$DATA/sygnal/vapid_private_key.pem" ]; then
  say "Generating the push notification keys"
  docker run --rm -v "$DATA/sygnal:/data" --entrypoint python "$SYGNAL_IMAGE" -c '
from py_vapid import Vapid02, b64urlencode
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
v = Vapid02()
v.generate_keys()
v.save_key("/data/vapid_private_key.pem")
raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
open("/data/vapid_public_key.txt", "w").write(b64urlencode(raw))
'
fi
VAPID_PUBLIC_KEY=$(cat "$DATA/sygnal/vapid_public_key.txt")
export VAPID_PUBLIC_KEY
PUSH_CONTACT_EMAIL=${PUSH_CONTACT_EMAIL:-push@$SERVER_NAME}
extra_endpoint=""
[ -n "${PUSH_EXTRA_ENDPOINT:-}" ] && extra_endpoint="      - \"$PUSH_EXTRA_ENDPOINT\""
# The iPhone app's notifications go through Apple: needs the APNs key (.p8) at
# data/sygnal/apns.p8 and APNS_KEY_ID / APNS_TEAM_ID in .env.
ios_app=""
if [ -f "$DATA/sygnal/apns.p8" ] && [ -n "${APNS_KEY_ID:-}" ] && [ -n "${APNS_TEAM_ID:-}" ]; then
  ios_app="  ${APNS_APP_ID:-fit.simas.inbox.ios}:
    type: inbox_apns.InboxApnsPushkin
    keyfile: /data/apns.p8
    key_id: \"$APNS_KEY_ID\"
    team_id: \"$APNS_TEAM_ID\"
    topic: \"${APNS_TOPIC:-fit.simas.inbox}\"
    platform: production
    push_type: alert"
fi
inside 'cat > /data/sygnal/sygnal.yaml' <<SYGNAL
log:
  setup:
    version: 1
    formatters: {normal: {format: "%(asctime)s %(levelname)-5s %(name)s %(message)s"}}
    handlers: {stderr: {class: logging.StreamHandler, formatter: normal, stream: "ext://sys.stderr"}}
    root: {handlers: [stderr], level: INFO}
    disable_existing_loggers: false
  access: {x_forwarded_for: false}
http:
  bind_addresses: ["0.0.0.0"]
  port: 5000
apps:
  fit.simas.inbox.web:
    type: webpush
    vapid_private_key: /data/vapid_private_key.pem
    vapid_contact_email: "$PUSH_CONTACT_EMAIL"
    # only ever deliver to the browsers' real push services
    allowed_endpoints:
      - "web.push.apple.com"
      - "fcm.googleapis.com"
      - "updates.push.services.mozilla.com"
      - "*.notify.windows.com"
$extra_endpoint
$ios_app
SYGNAL

say "Configuring Synapse"
yq -i "
  .database = {\"name\": \"psycopg2\", \"args\": {\"user\": \"synapse\", \"password\": strenv(POSTGRES_PASSWORD), \"database\": \"synapse\", \"host\": \"postgres\", \"cp_min\": 5, \"cp_max\": 10}} |
  .listeners = [{\"port\": 8008, \"tls\": false, \"type\": \"http\", \"x_forwarded\": true, \"bind_addresses\": [\"0.0.0.0\"], \"resources\": [{\"names\": [\"client\"], \"compress\": false}]}] |
  .public_baseurl = \"https://\" + strenv(MATRIX_HOST) + \"/\" |
  .federation_domain_whitelist = [] |
  .trusted_key_servers = [] |
  .suppress_key_server_warning = true |
  .presence.enabled = false |
  .enable_registration = false |
  .enable_authenticated_media = true |
  .max_upload_size = \"1G\" |
  .url_preview_enabled = false |
  .experimental_features.msc2654_enabled = true |
  .experimental_features.msc3664_enabled = true |
  .app_service_config_files = [$regs] |
  .ip_range_whitelist = [\"172.31.250.0/24\"] |
  .extra_well_known_client_content = {\"fit.simas.inbox.push\": {\"app_id\": \"fit.simas.inbox.web\", \"gateway_url\": \"http://sygnal:5000/_matrix/push/v1/notify\", \"vapid_public_key\": strenv(VAPID_PUBLIC_KEY)}}
" /data/synapse/homeserver.yaml

# --- Start -----------------------------------------------------------------
say "Starting the database and Matrix server"
synapse_was_running=$(docker compose ps -q synapse 2>/dev/null || true)
docker compose up -d --wait postgres synapse
if [ -n "$synapse_was_running" ]; then
  # Synapse reads the bridges' registrations only when it starts
  say "Restarting the Matrix server to load the bridge settings"
  docker compose restart synapse
  docker compose up -d --wait synapse
fi

if [ ! -f "$DATA/.admin-created" ]; then
  say "Creating your account @$ADMIN_USER:$SERVER_NAME"
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u "$ADMIN_USER" -p "$ADMIN_PASSWORD" -a http://localhost:8008
  else
    docker compose exec synapse register_new_matrix_user -c /data/homeserver.yaml -u "$ADMIN_USER" -a http://localhost:8008
  fi
  touch "$DATA/.admin-created"
fi

say "Starting everything ($COMPOSE_PROFILES)"
docker compose up -d

if [ "${SUGGEST:-}" = 1 ]; then
  say "Reply suggestions: fetching the models (first time: a few GB)"
  docker compose exec -T ollama ollama pull "${SUGGEST_MODEL:-gemma3:4b}" >/dev/null
  docker compose exec -T ollama ollama pull "${SUGGEST_EMBED_MODEL:-bge-m3}" >/dev/null
  if [ ! -f "$DATA/suggest/suggest.db" ]; then
    say "Reply suggestions: learning from your chat history (runs in the background)"
    nohup docker compose run --rm -T suggest python /app/suggest.py --backfill > "$DATA/suggest-backfill.log" 2>&1 &
  fi
fi

# the old cron-based contacts sync is replaced by the contacts service
( crontab -l 2>/dev/null | grep -v '/contacts.sh' ) | crontab - 2>/dev/null || true
# keep push notifications reaching every device (see push-watchdog.sh)
bash "$(dirname "$0")/push-watchdog.sh" --install >/dev/null 2>&1 || true

cat <<EOF

Done. Your Matrix server is running.

  Sign in to the Inbox app with:
    Server:   https://$MATRIX_HOST
    Username: $ADMIN_USER

  Then open Settings → Connected apps to log in to each chat app,
  and Settings → Notifications to get notified when the app is closed.
  Logs: docker compose logs -f <service>   (synapse, sygnal${BRIDGES:+, ${BRIDGES// /, }})
EOF
