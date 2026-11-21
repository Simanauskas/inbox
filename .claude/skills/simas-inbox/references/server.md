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
`max_initial_messages: 1000`. WhatsApp: `network.history_sync.request_full_sync: true`
(a year of history). Telegram: `network.api_id/api_hash`.

**iMessage (mautrix-imessage, legacy layout)** with `imessage.platform: bluebubbles`,
`bluebubbles_url` (default `http://host.docker.internal:1234`; compose adds
`extra_hosts: host.docker.internal:host-gateway`) and `bluebubbles_password`;
`homeserver.websocket_proxy: null`; database **SQLite only**
(`sqlite3-fk-wal`, `file:/data/mautrix-imessage.db?_txlock=immediate` — on
Postgres its schema fails with `syntax error at or near "NEW"`);
`bridge.user = @s:…`;
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
- iMessage: no login; connects to BlueBubbles by itself.

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
