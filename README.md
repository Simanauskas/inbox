# Inbox

One app for WhatsApp, Telegram, Messenger, Instagram and iMessage,
with **one thread per person** no matter which app they write from.

- Each person can have several chats (e.g. WhatsApp + Telegram). Their messages
  are merged into one timeline, each tagged with the app it came from.
- New messages go to the person's **default app**.
- If they wrote to you on another app recently (12 h by default, change it in
  Settings), your reply goes back **there** instead.
- You can always tap "Sending via …" to pick the app by hand. Replying to a
  specific message always goes to the app that message came from.
- No ads, no tracking: everything lives on your own server.

```
 phone / laptop                      your server (Docker)
┌──────────────┐   HTTPS   ┌───────────────────────────────────────────┐
│  Inbox app   │──────────▶│ Synapse (Matrix) ◀─▶ WhatsApp bridge ─────┼─▶ WhatsApp
│ (web app on  │           │        ▲         ◀─▶ Telegram bridge ─────┼─▶ Telegram
│ home screen) │           │        │         ◀─▶ Messenger bridge ────┼─▶ Messenger
└──────────────┘           │    Postgres      ◀─▶ Instagram bridge ────┼─▶ Instagram
                           └───────────────────────────────────────────┘
          iMessage bridge ◀─▶ BlueBubbles app on the Mac ─▶ iMessage
```

The bridges are the open-source [mautrix](https://docs.mau.fi/bridges/) bridges.
The app is in `app/`; the server setup is in `server/`.

## Folders

| Path | What |
|---|---|
| `app/` | The web app (React + Vite). Talks to Matrix directly; no backend of its own. |
| `server/` | `docker-compose.yml` + `setup.sh` for the server. |
| `dev/` | Local test server with a mock bridge (fake contacts on all four apps) and an end-to-end test. |

Which chats belong to the same person, the default app per person and the
reply window are saved on your Matrix account (account data
`fit.simas.inbox.people`), so every device you sign in on sees the same thing.

---

## 1. Set up the server

You need a machine that's always on and has Docker:

- **A small cloud server.** For example, Hetzner CX22 (~€4.50/month, Ubuntu).
  Install Docker with `curl -fsSL https://get.docker.com | sh`.
- **Or the Mac**, if it's new enough to run Docker Desktop. That's free, and
  it's also where iMessage has to run.

Then:

```bash
git clone https://github.com/Simanauskas/inbox && cd inbox/server
cp .env.example .env
nano .env        # set SERVER_NAME, MATRIX_HOST, ADMIN_USER, Telegram keys, tunnel token
./setup.sh       # asks you to choose your password at the end
```

`setup.sh` generates every config file and secret, creates one database per
bridge, wires the bridges into Synapse, creates your account and starts
everything. Re-running it is safe.

### Telegram API keys

Telegram makes each bridge use its own API keys. Go to
<https://my.telegram.org/apps>, log in with your phone number, create an app
(any name), and copy **api_id** and **api_hash** into `.env`.

### Make it reachable over HTTPS (Cloudflare Tunnel, free)

No open ports, no certificates to manage:

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
   (type *Cloudflared*). Name it `inbox`.
2. Copy the token from the install command into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
3. Add a **Public hostname**: `matrix.simas.fit` → Service `HTTP` → `synapse:8008`.
4. Run `./setup.sh` again (or `docker compose up -d`).

Check it: `https://matrix.simas.fit/_matrix/client/versions` should return JSON.

## 2. Put the app online

Cloudflare Pages, same as your other sites:

- **Create project** → connect `Simanauskas/inbox`, production branch `main`
- **Root directory:** `app` · **Build command:** `npm run build` · **Output:** `dist`
- **Environment variable:** `VITE_HOMESERVER=https://matrix.simas.fit` (pre-fills the login screen)
- **Custom domain:** e.g. `inbox.simas.fit`

On iPhone: open it in Safari → Share → **Add to Home Screen**.

## 3. Connect each app

In the Inbox app go to **Settings → Connected apps** and tap **Open** next
to each app. That opens a chat with the bridge bot:

| App | What to send | Then |
|---|---|---|
| WhatsApp | `login qr` | WhatsApp on your phone → Settings → Linked devices → Link a device → scan the code. History from the last year comes in. |
| Telegram | `login` | Enter your phone number, then the code Telegram sends you (and your 2FA password if you have one). |
| Messenger | `login` | Pick a method. Username and password is easiest. If Facebook complains, use the messenger.com cookie method the bot describes. |
| Instagram | `login` | The bot asks for cookies from instagram.com: log in on a computer, open the browser's developer tools → Application → Cookies, and copy the values it asks for. |

Your chats start appearing within a minute. Then tap the banner
**"N people are on more than one app"** to combine people's chats, and pick
each person's default app.

> WhatsApp, Messenger and Instagram don't officially allow third-party apps.
> The bridges act like a linked device or a browser login. Lots of people
> use them, but expect an occasional "confirm it's you" prompt.

## 4. iMessage

iMessage only exists on Apple devices, so a Mac signed in to your Apple ID
has to stay on. It runs the free **BlueBubbles Server** app, and the iMessage
bridge on your server talks to it. When the server runs on that same Mac,
nothing else is needed.

1. On the Mac, open **Messages** and check you're signed in and can send and receive.
2. Download **BlueBubbles Server** for macOS from <https://bluebubbles.app/downloads/>
   and open it. Give it the permissions it asks for (Full Disk Access, Accessibility).
3. In its setup, choose a **server password**. You don't need its proxy or
   Cloudflare option if the Inbox server runs on the same Mac. Leave the port at `1234`.
4. Put that password in `server/.env` as `BLUEBUBBLES_PASSWORD`, then run `./setup.sh` again.
5. In the Inbox app, Settings → Connected apps → iMessage → **Open**: the bot
   should say it's connected. Chats from the last 90 days come in with their history.

Keep the Mac awake: System Preferences → Battery → Power Adapter → turn on
"Prevent computer from sleeping automatically when the display is off", and
keep the lid open.

**Replies, reactions, read receipts and typing indicators** sent *from* Inbox
need BlueBubbles' optional "Private API". That means switching off a macOS
protection (SIP) on the Mac; BlueBubbles' docs walk through it. Without it,
texts, photos and files work both ways, and you still *see* their reactions
and replies.

**If the server later moves off the Mac** (e.g. to a rented server), turn on
BlueBubbles' Cloudflare option, copy its URL into `BLUEBUBBLES_URL` in `.env`,
and run `./setup.sh` again.

## 5. Notifications

`setup.sh` also runs a push gateway (Sygnal) next to the Matrix server. It
sends new messages to your phone through Apple's or Google's push service, so
you're notified even when Inbox is closed. Its keys are generated
automatically, and the app finds them by itself.

- **iPhone (iOS 16.4+):** open Inbox in Safari → Share → **Add to Home Screen**,
  open it *from the Home Screen*, then Settings → **Turn on notifications**.
  iPhones only allow notifications for Home Screen web apps.
- **Android / desktop:** Settings → **Turn on notifications**.

Tapping a notification opens that person's thread, and the app icon shows the
unread count. Bridges import old history when you connect an app; those old
messages don't buzz one by one but show as a single silent "Importing older
messages…" notification. Invites to newly imported chats don't notify at all.

## 6. Names from your contacts

People show up the way you saved them in your iPhone/iCloud contacts. The
server reads your contacts from BlueBubbles on the Mac every 15 minutes
(`server/contacts.sh`, set up by `setup.sh`); if you rename someone in Inbox,
your name wins. On a person's page Inbox can **add them to your contacts** or
**update their card** with numbers/emails it learned from the apps — your
iPhone asks first; nothing is changed on its own.

## Updating

```bash
cd server && docker compose pull && docker compose up -d
```

Bridges need updating every few weeks, because the apps change their
protocols. If a bridge stops working, updating usually fixes it.

## Backups

Configs, keys and media are in `server/data/`; the database lives in Docker's
own storage (volume `inbox_pgdata`). `server/backup.sh` saves both (without
media, which is large) into `server/backups/`, keeping the last 7:

```bash
cd server && ./backup.sh              # one now
cd server && ./backup.sh --install    # every night at 04:17
```

`move.sh import` installs the nightly one for you. To keep copies off the
server too, pull them to another machine now and then, e.g. from the Mac:

```bash
rsync -a root@SERVER-IP:/root/server/backups/ ~/InboxBackups/
```

## Moving to another server

Everything — logins to every app, chats, combined people, settings — moves
with two commands. Nothing has to be logged in again.

1. On the old machine, in the `server` folder:
   ```bash
   ./move.sh export
   ```
   It stops the server there (leave it stopped: two copies logged in to the
   same WhatsApp etc. would fight) and writes `inbox-move.tar.gz`.
2. Copy it over:
   ```bash
   scp inbox-move.tar.gz root@NEW-SERVER-IP:/root/
   ```
3. On the new server (Ubuntu, as root):
   ```bash
   cd /root && tar xzf inbox-move.tar.gz && cd server && ./move.sh import
   ```
   It installs Docker if needed, restores the database, runs `setup.sh` and
   schedules the nightly backup. The Cloudflare tunnel reconnects from the new
   machine, so `matrix.simas.fit` and the app don't change.

**iMessage after moving off the Mac.** BlueBubbles has to stay on the Mac, so
the server reaches it through a second Cloudflare tunnel:

1. Cloudflare → Zero Trust → Networks → Tunnels → create `inbox-mac` (Docker);
   public hostname `bb.simas.fit` → HTTP → `http://host.docker.internal:1234`.
2. On the Mac, in the repo's `mac/` folder:
   ```bash
   echo "TUNNEL_TOKEN=<inbox-mac token>" > .env && docker compose up -d
   ```
3. Import with the new address (or edit `BLUEBUBBLES_URL` in `.env` and re-run `./setup.sh`):
   ```bash
   BLUEBUBBLES_URL=https://bb.simas.fit ./move.sh import
   ```
4. Cloudflare → your domain → Security → WAF → custom rule: block when
   *Hostname equals `bb.simas.fit`* and *IP source address does not equal
   NEW-SERVER-IP*, so only your server can talk to BlueBubbles.

---

## Developing locally

Needs Docker and Node 20+.

```bash
dev/reset.sh                 # local Synapse on :8008 with fake WhatsApp/Telegram/IG/Messenger chats
cd app && npm install && npm run dev   # http://localhost:5180 → server http://localhost:8008, simas / test1234
npm test                     # unit tests for merging + channel picking
node ../dev/e2e.mjs          # browser test of the whole flow (needs the dev server + npm run dev)
python3 dev/mockbridge.py say whatsapp rokas "hello"   # fake an incoming message
```

Push notifications need the full server (Sygnal isn't in the dev setup). Run
`server/setup.sh` in a scratch copy with `PUSH_EXTRA_ENDPOINT=mockpush` in its
`.env`, then:

```bash
python3 dev/push_check.py <server dir> http://localhost:8008 s <password>        # server → Sygnal → push service, decrypted
npm run build && npm run preview -- --port 5181                                 # in app/
node dev/push_browser_check.mjs <server dir> http://localhost:8008 s <password> # app side: subscribe, notifications, clearing
```

## Not done yet

- **Starting a brand-new chat** with someone you've never messaged on that
  app. For now you can do it from the bridge bot (`help` lists the commands).
- **Voice message recording**. Playing voice messages works; recording them doesn't yet.
