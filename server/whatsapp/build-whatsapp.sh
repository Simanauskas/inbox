#!/usr/bin/env bash
# Builds sky's WhatsApp bridge: upstream mautrix-whatsapp + viewing.patch, which lets
# Inbox say "this chat is open" (fit.simas.inbox.viewing events) so the bridge shows
# you online on WhatsApp while a chat is open and WhatsApp sends typing notifications.
# Usage (on the server, in /root/server):  bash whatsapp/build-whatsapp.sh
# then set WHATSAPP_IMAGE=local/mautrix-whatsapp:sky in .env and: docker compose up -d whatsapp
set -euo pipefail
cd "$(dirname "$0")"
REV=${WHATSAPP_REV:-eecc2538}   # version the patch was made for
rm -rf src && git clone -q https://github.com/mautrix/whatsapp.git src
git -C src checkout -q "$REV"
git -C src apply ../viewing.patch
docker build -t local/mautrix-whatsapp:sky src
rm -rf src
echo "Built local/mautrix-whatsapp:sky"
