#!/usr/bin/env bash
# Move the Inbox server to another machine, keeping every login, chat and setting.
#
# On the old machine (in this folder):
#   ./move.sh export            → stops the server, writes inbox-move.tar.gz
#   scp inbox-move.tar.gz root@NEW-IP:/root/
#
# On the new machine (Linux, as root):
#   tar xzf inbox-move.tar.gz && cd server && ./move.sh import   (the folder keeps its name)
#
# The export contains this whole folder (.env, data/, scripts) plus a dump of
# the database. Don't start the old server again afterwards: two copies of
# the bridges logged in to the same accounts would fight each other.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

export_() {
  [ -f .env ] || die "No .env here: run this in the server folder of the running Inbox."
  say "Stopping the bridges and the Matrix server"
  docker compose stop
  say "Saving the database"
  docker compose up -d --wait postgres
  docker compose exec -T postgres pg_dumpall -U synapse --clean --if-exists | gzip > inbox-db.sql.gz
  docker compose stop postgres
  say "Packing everything into inbox-move.tar.gz"
  # COPYFILE_DISABLE: stop macOS tar adding ._ metadata files
  # (written next to the folder, not inside it, so tar doesn't see it change)
  name=$(basename "$PWD")
  (cd .. && COPYFILE_DISABLE=1 tar czf inbox-move.tar.gz --exclude "$name/inbox-move.tar.gz" --exclude "$name/backups" "$name")
  mv ../inbox-move.tar.gz .
  rm -f inbox-db.sql.gz
  ls -lh inbox-move.tar.gz
  cat <<EOF

Done. The server here is stopped; leave it stopped.
Copy the file to the new server, e.g.:

  scp $(pwd)/inbox-move.tar.gz root@NEW-SERVER-IP:/root/

EOF
}

install_docker() {
  command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && return
  say "Installing Docker"
  command -v curl >/dev/null || (apt-get update -q && apt-get install -yq curl)
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

import_() {
  [ -f .env ] || die "No .env here: unpack inbox-move.tar.gz and run this inside its server folder."
  [ -f inbox-db.sql.gz ] || die "inbox-db.sql.gz is missing from the export."
  [ "$(id -u)" = 0 ] || die "Run this as root (or with sudo)."
  install_docker

  # Files came from another machine: give each service back ownership of its folder
  # (Synapse runs as 991, the bridges fix their own on start).
  docker run --rm -v "$PWD/data:/data" alpine:3 chown -R 991:991 /data/synapse

  if [ -n "${BLUEBUBBLES_URL:-}" ]; then
    sed -i.bak "s|^BLUEBUBBLES_URL=.*|BLUEBUBBLES_URL=$BLUEBUBBLES_URL|" .env && rm -f .env.bak
  fi

  say "Restoring the database"
  set -a; . ./.env; set +a
  docker compose up -d --wait postgres
  gunzip -c inbox-db.sql.gz | docker compose exec -T postgres psql -q -U synapse -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>restore-errors.log || true
  # the only expected complaints: the database user and the database we're connected to already exist
  if grep -v -E 'role "synapse" already exists|current user cannot be dropped|cannot drop the currently open database|database "postgres" already exists|^$' restore-errors.log | grep -q .; then
    echo "Some database messages to check in restore-errors.log:"; grep -v -E 'already exists|cannot be dropped|currently open' restore-errors.log | head -20
  else
    rm -f restore-errors.log
  fi
  rm -f inbox-db.sql.gz

  say "Starting everything with ./setup.sh"
  ./setup.sh
  ./backup.sh --install
}

case "${1:-}" in
  export) export_ ;;
  import) import_ ;;
  *) echo "Usage: ./move.sh export   (on the old machine)"; echo "       ./move.sh import   (on the new one, as root)"; exit 1 ;;
esac
