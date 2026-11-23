#!/usr/bin/env bash
# Builds sky's Messenger bridge: upstream mautrix-meta plus deep-history.patch, which
# lets a freshly created chat fetch all its encrypted history (page by page, one chat
# at a time, 3-6 s apart) instead of only the newest ~80 messages.
# Usage (on the server, in /root/server):  bash meta/build-meta.sh
# then set META_IMAGE=local/mautrix-meta:sky-history in .env and run: docker compose up -d facebook
set -euo pipefail
cd "$(dirname "$0")"
REV=${META_REV:-721148544bfb94f3d7078afd5d393b2a9ae8a3ee}   # version the patch was made for
rm -rf src && git clone -q https://github.com/mautrix/meta.git src
git -C src checkout -q "$REV"
git -C src apply ../deep-history.patch
docker build -t local/mautrix-meta:sky-history src
rm -rf src
echo "Built local/mautrix-meta:sky-history"
