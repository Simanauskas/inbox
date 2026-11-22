# Inbox: testing

## Local dev server (`dev/`)

- `dev/reset.sh` — wipes and starts Synapse on `localhost:8008` (container
  `inbox-dev-synapse`, server name `inbox.test`, user **`simas` / `test1234`**)
  and seeds it with `dev/mockbridge.py` (runs `dev/init.sh` first if needed).
- `dev/mockbridge.py` — fake appservice: ghosts + DM rooms with real-looking
  `m.bridge` state for WhatsApp/Telegram/Instagram/Messenger (Rokas WA+TG,
  Ilona WA+IG+FB, Tomas FB, Mantas TG+IG with different names, Eglė WA+TG),
  a WhatsApp group "Hyrox crew", a bridge-bot room, history with
  timestamps. `say <net> <person> "text"` injects an inbound message;
  `messages <net> <person>` prints a room's last messages.
- App: `cd app && npm install && npm run dev` (port 5180). Unit tests:
  `npm test` (people.js merging/channel rules, network detection, push payloads).
- `node dev/e2e.mjs [shot dir]` — Playwright, iPhone 13: login, merge
  suggestions (4), combine all (6 entries), reply routed to Telegram then to
  WhatsApp after he writes there, manual pick sticks, desktop layout.
  Needs a fresh `dev/reset.sh` each run (it merges everything).
  iCloud contacts part: runs the real `server/contacts.py --once` against a
  stand-in CardDAV server at `DAV_URL` (default http://localhost:5232; skipped
  if nothing answers). Radicale: `python3 -m venv v && v/bin/pip install radicale`,
  config `[server] hosts=0.0.0.0:5232`, `[auth] type=none`, `[storage]
  filesystem_folder=…`. The test recreates book `/simas/inbox-e2e/` (Rokas, Eglė
  with only an email), adds Ilona as a new card and adds Eglė's WhatsApp number.

## Push tests (need the full server, not the dev one)

Run `server/setup.sh` in a scratch copy (different host port, `BRIDGES=""`,
`PUSH_EXTRA_ENDPOINT=mockpush` in `.env`). Then:
- `dev/push_check.py <dir> <hs> s <pw>` (needs `pip install http_ece cryptography`):
  stand-in push service container `mockpush` on the compose network,
  registers a pusher, another user messages, decrypts like a browser.
- `npm run build && npm run preview -- --port 5181`, then
  `node dev/push_browser_check.mjs <dir> <hs> s <pw>`: stubs the browser's
  subscription, checks pusher registration, invite rule off, exactly one push,
  worker notifications (fresh vs old/imported via the doublepuppet as_token
  with `?ts=`), clearing on read, turning off.
- Both clear leftover `mockpush` pushers first (two pushers = two pushes).
  The stand-in must reply with `Content-Length: 0`, or Sygnal errors and
  Synapse retries with backoff.

## Cloud-container quirks

- Docker isn't running at start: `(dockerd > <log> 2>&1 &)`; it can die
  between turns — restart it, images survive.
- Synapse needs `bind_addresses: ['0.0.0.0']` (IPv6 bind fails).
- `dock.mau.dev` is blocked; don't tag local builds as those images. Use
  stand-in images (`WHATSAPP_IMAGE=…` overrides in `.env`).
- Playwright: `require('playwright')` via `createRequire` in .mjs. The slim
  headless shell always reports notifications as denied — use
  `chromium.launch({ channel: 'chromium' })`.
- Docker Hub may rate-limit pulls (429); retry after ~20 s.
- Ad sites like skelbiu.lt weren't reachable from the fetch tool even after
  allowing the host.
