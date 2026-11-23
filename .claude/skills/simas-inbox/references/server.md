# Inbox server: setup, bridges, gotchas

## setup.sh (idempotent; only needs Docker)

1. Reads `server/.env` (copies `.env.example` and stops if missing). Generates
   `POSTGRES_PASSWORD`, writes `COMPOSE_PROFILES` (= enabled bridges + `tunnel`
   when `CLOUDFLARE_TUNNEL_TOKEN` is set). Skips Telegram without
   `TELEGRAM_API_ID`, iMessage without `BLUEBUBBLES_PASSWORD`.
2. Generates Synapse config (`matrixdotorg/synapse generate`) and a
   `doublepuppet.yaml` appservice (non-exclusive `@.*:<server>`).
3. Per bridge: first `docker run` of the image writes `config.yaml` and exits;
   setup patches it with `mikefarah/yq:4` (run in a container as root, so file
   ownership never matters); second run writes `registration.yaml`; copied to
   `data/synapse/<bridge>-registration.yaml`.
4. Push: generates VAPID keys with the Sygnal image's `py_vapid`, writes
   `data/sygnal/sygnal.yaml` (see push.md).
5. Patches `homeserver.yaml` (Postgres, client-only listener, federation off,
   `public_baseurl`, presence off, uploads 100M, appservice list,
   `ip_range_whitelist` for the compose subnet, push info in
   `extra_well_known_client_content`).
6. `docker compose up -d --wait postgres synapse`, creates the admin user once
   (`data/.admin-created`; `ADMIN_PASSWORD` env for non-interactive), then
   `docker compose up -d`.

Compose project is named `inbox` (containers `inbox-…`, network
`inbox_default`). Postgres data is in the named volume `inbox_pgdata`, not
`server/data/postgres`: on his MacBook Air (Docker Desktop 4.24, Big Sur) a
bind-mounted Postgres took ~2.5 min to initialise and failed the health check.
Postgres and Synapse health checks have `start_period: 10m`.

Compose network subnet is fixed to `172.31.250.0/24` (Synapse refuses private
addresses for push unless whitelisted). Synapse is published only on
`127.0.0.1:8008`; the `cloudflared` service (profile `tunnel`) exposes it.

## Bridges

| Bridge | Image | Port | Bot | Ghost prefix | `m.bridge` protocol id |
|---|---|---|---|---|---|
| WhatsApp | `dock.mau.dev/mautrix/whatsapp:latest` | 29318 | `@whatsappbot` | `whatsapp_<phone>` | `whatsapp` |
| Telegram | `dock.mau.dev/mautrix/telegram:latest` (Go, bridgev2) | 29317 | `@telegrambot` | `telegram_` | `telegram` |
| Messenger | `dock.mau.dev/mautrix/meta:latest` | 29319 | `@facebookbot` | `facebook_` | `facebookgo` |
| Instagram | `dock.mau.dev/mautrix/meta:ig-latest` (separate binary now) | 29330 | `@instagrambot` | `instagram_` | `instagramgo` |
| iMessage | `dock.mau.dev/mautrix/imessage:latest` (older layout) | 29331 | `@imessagebot` | `imessage_<digits>` | `imessage` |

The first four share the **bridgev2** config layout. setup.sh sets: homeserver
address/domain, appservice address/hostname/port, **explicit
`appservice.id` / `bot.username` / `username_template`** (Synapse refuses two
registrations with the same id), Postgres DB per bridge,
`bridge.permissions` (server = user, `@s:…` = admin),
`personal_filtering_spaces: false`, double puppeting via
`double_puppet.secrets[server] = "as_token:<doublepuppet token>"`,
`encryption.allow: false`, `backfill.enabled: true`,
`max_initial_messages: 1000` (Messenger 10000). WhatsApp: `network.history_sync.request_full_sync: true`
(a year of history) and `network.displayname_template` = your contact
name (`.FullName`) without the default " (WA)" tag (the app also strips such
tags with `cleanName`). Telegram: `network.api_id/api_hash`. Messenger:
`network.e2ee_backfill: true` — most Messenger 1:1 chats are end-to-end
encrypted, so the bridge creates their rooms but gets no history unless it
restores Messenger's encrypted backup with his 6-digit secure-storage PIN,
asked during login (existing login: `list-logins`, then `relogin <id>` in
the Messenger bot chat). The app tucks message-less chats into a collapsed
"N chats with no messages yet" row at the bottom of the inbox.

**Messenger history (learned 23 Nov 2026).** Chats created before the backup was
unlocked stay empty forever: on Synapse, forward backfill only adds messages *newer*
than the room's latest one ("Cutting off forward backfill messages older than latest
bridged message"), and the backwards queue needs Beeper's server. Messenger's history
server also returns one page (~80 msgs) per request and upstream only asks once.
Fixes on sky:
- Own bridge build `local/mautrix-meta:sky-history` (`META_IMAGE` in `.env`), from
  `server/meta/build-meta.sh` + `deep-history.patch`: for a fresh room (no anchor) it
  pages back until `max_initial_messages` (10000, set by setup.sh for facebook), one
  chat at a time (global mutex), 3–6 s between pages. Catch-up after reconnects stays
  one page (an early version paged there too: wasteful, fixed).
- To refill an existing chat: stop bridge → delete its `message`/`reaction` rows and
  set `portal.mxid = NULL` in the `facebook` DB → start → bot command
  `create-portal <portal id>` in the management room (the bridge often recreates it
  by itself on start). New room id ⇒ swap old→new in account data
  `fit.simas.inbox.people` and leave+forget the old room as @s (double-puppet
  as_token with `?user_id=`). Only works for encrypted DMs (thread_type 15);
  non-encrypted groups can't be refetched this way (no bundled data). Backups and
  logs of the 23 Nov run: `/root/server/backups/pre-fb-history-*`, `fb-rebuild*.log`.
- Media from the backup older than ~10 months fails with 403 (the CDN copy is gone);
  the bridge has no other way to fetch it, so the room shows "Failed to transfer
  media". Recent photos/videos/voice come through.

**iMessage (mautrix-imessage, legacy layout)** with `imessage.platform: bluebubbles`,
`bluebubbles_url` (default `http://host.docker.internal:1234`; compose adds
`extra_hosts: host.docker.internal:host-gateway`) and `bluebubbles_password`;
`homeserver.websocket_proxy: null`; database **SQLite only**
(`sqlite3-fk-wal`, `file:/data/mautrix-imessage.db?_txlock=immediate` — on
Postgres its schema fails with `syntax error at or near "NEW"`);
`bridge.user = @s:…`; registration `url` is set by setup.sh to `http://imessage:29331` (the bridge drops `appservice.address`, leaving url empty → Synapse `M_URL_NOT_SET`); setup.sh restarts Synapse on re-runs so it reloads registrations;
`bridge.displayname_template: "{{.}}"` (the default adds " (iMessage)", which
breaks name matching); `backfill.initial_limit 1000`, `initial_sync_max_age 90`
days. It has **no `as_token:` double puppeting** — uses
`bridge.login_shared_secret: "appservice"`, which needs its registration to
also list `^@s:<server>$` as a non-exclusive user namespace (setup.sh appends it).
BlueBubbles needs its optional **Private API (SIP disabled)** for sending
reactions, replies, read receipts and typing; without it texts and media work
both ways. Phone numbers in iMessage ghost ids may be escaped (`=2b` = `+`);
`phoneFromUser` decodes that.

### Logging in (Settings → Connected apps → Open = DM with the bot)

- WhatsApp: `login qr` → phone: Settings → Linked devices → Link a device.
- Telegram: `login` → phone number → code (→ 2FA password).
- Messenger: `login` → username/password flow (Messenger iOS/Android API) is
  easiest; cookie flows (facebook.com / messenger.com) as fallback.
- Instagram: `login` → cookies from instagram.com via browser dev tools.
- iMessage: no login; connects to BlueBubbles by itself. Names show as phone
  numbers if the Mac had no contacts at first sync: add contacts on the Mac,
  send `refresh-contacts` in the iMessage bot chat, then
  `docker compose restart imessage` (participants re-sync on startup).

WhatsApp/Messenger/Instagram aren't officially allowed; occasional "confirm
it's you" prompts are normal. Bridges need `docker compose pull && up -d`
every few weeks; updating fixes most breakages.

## Gotchas already hit

- A Synapse login → first sync right after a change can return a **cached**
  pre-change response (Synapse caches /sync ~2 min per token+filter); it
  corrects itself on the next incremental sync.
- `register_new_matrix_user` and repeated test logins can hit Synapse's
  `rc_login` limit (429).
- Docker Desktop on the Mac: `extra_hosts host-gateway` and
  `host.docker.internal` both work.
- The real `dock.mau.dev` images were never pulled in a cloud session (host
  blocked there); setup was verified with stand-in bridge images built from the
  bridges' own example configs.

**iMessage history (23 Nov 2026).** The Mac had 721 chats / ~36k messages but only 27
chats reached sky: `initial_sync_max_age` was 90 days. Now 36500 days and
`initial_limit` 10000 (setup.sh). BlueBubbles' API is behind Cloudflare: Python's
default User-Agent gets 403, send `User-Agent: curl/…`. The import was slowed by
Synapse rate-limiting @s (the iMessage bridge sends my own messages as a real login,
not via as_token); lifted with the admin API
`POST /_synapse/admin/v1/users/@s:matrix.simas.fit/override_ratelimit {"messages_per_second":0,"burst_count":0}`
(stored in Synapse's DB, survives restarts).
- iMessage bridge also stops at 1000 msgs per new chat (`GetMessagesWithLimit` queries
  BlueBubbles with `paginate=false`). sky runs `local/mautrix-imessage:sky`
  (`IMESSAGE_IMAGE`, `server/imessage/` + `full-history.patch`, no libheif: the Go
  binding doesn't build against Alpine 3.24's libheif). Chats whose import hit 429s
  had messages in the room but not in the bridge DB → rebuilt from scratch: stop
  bridge, delete their `message`/`tapback`/`backfill_*` rows, `portal.mxid=NULL`,
  start; startup sync recreates the rooms. SMS and iMessage chats for one number are
  merged via `merged_chat`, so compare counts per target guid.
