#!/usr/bin/env bash
# Builds sky's iMessage bridge: upstream mautrix-imessage + full-history.patch + voice-memo.patch (a new
# chat gets all its messages up to initial_limit, not just the newest 1000).
# Usage (on the server, in /root/server):  bash imessage/build-imessage.sh
# then set IMESSAGE_IMAGE=local/mautrix-imessage:sky in .env and: docker compose up -d imessage
set -euo pipefail
cd "$(dirname "$0")"
REV=${IMESSAGE_REV:-300ba6d0}   # version the patch was made for
rm -rf src && git clone -q https://github.com/mautrix/imessage.git src
git -C src checkout -q "$REV"
git -C src apply ../full-history.patch
git -C src apply ../voice-memo.patch   # voice notes from the app arrive as real iMessage voice notes
cp Dockerfile src/Dockerfile.sky
docker build -t local/mautrix-imessage:sky -f src/Dockerfile.sky src
rm -rf src
echo "Built local/mautrix-imessage:sky"
