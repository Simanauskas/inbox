---
name: "simas-inbox"
description: Simas Simanauskas's own unified messaging app "Inbox" (repo Simanauskas/inbox, app at inbox.simas.fit, Matrix server matrix.simas.fit) — one thread per person merging his WhatsApp, Telegram, Messenger, Instagram and iMessage chats through a self-hosted Matrix (Synapse) server with mautrix bridges, BlueBubbles for iMessage and Sygnal for push notifications. Use whenever he mentions Inbox, inbox.simas.fit, matrix.simas.fit, combining/merging his chats or messaging apps, a person's default channel or "reply on the app they wrote from", connecting or logging in to WhatsApp/Telegram/Messenger/Instagram/iMessage bridges, BlueBubbles, Sygnal or push notifications for Inbox, setup.sh / docker compose for the messaging server, the MacBook Air or Mac mini that runs it, the Cloudflare tunnel "inbox", or a bridge that stopped working, messages not arriving, or a person showing up twice — even if he doesn't say "Inbox". Not for email or iCloud mail sorting (icloud-mail-rules) or his training dashboard (simas-fit-update).
---

# Inbox — one thread per person across all his messaging apps

Built 21 Nov 2026. He wanted one ad-free app for WhatsApp, Telegram,
Messenger, Instagram and iMessage, where each **person** is one thread with
all their history, new messages go to that person's **default app**, and
replies go back on **the app they last wrote from**. Viber was dropped (no
workable bridge). He looked at Beeper (merged chats are on its $9.99/month
plan) and chose to self-host instead.

Repo: **`Simanauskas/inbox`** (private; `main` deploys the app). It started
in `Simanauskas/dashboard/inbox` and was moved with its history — nothing for
it lives in `dashboard` any more.

| Thing | Where |
|---|---|
| Web app (React + Vite, home-screen PWA) | `app/` → Cloudflare Pages, root dir `app`, branch `main`, env `VITE_HOMESERVER=https://matrix.simas.fit`, domain `inbox.simas.fit` |
| Server (Docker compose) | `server/` — `docker-compose.yml`, `setup.sh`, `.env.example`, `postgres-init.sh` |
| Local test server + mock bridge + tests | `dev/` |
| Guide for him | `README.md` (setup steps 1–5, updating, backups) |
| His account | **`@s:matrix.simas.fit`** (username `s`; server name can't change later) |
| Public address | Cloudflare Tunnel **`inbox`**, public hostname `matrix.simas.fit` → service URL **`http://synapse:8008`** (the form needs the `http://` prefix) |

## Architecture

```
app (browser) ──HTTPS──▶ Synapse ◀─▶ mautrix bridges ─▶ WhatsApp / Telegram / Messenger / Instagram
                            │     ◀─▶ mautrix-imessage ─▶ BlueBubbles app on the Mac ─▶ iMessage
                            └─▶ Sygnal ─▶ Apple / Google web push ─▶ phone
```

- **No backend of its own.** The app is a thin Matrix client (`app/src/matrix.js`:
  sync loop, pagination, send/upload, authenticated media as blob URLs). Rooms
  are unencrypted (own server, bridges encryption off), so there's no crypto.
- **Loading**: the first sync asks for 5 events per room (20 made the first load
  exceed Cloudflare's 100 s limit once he had hundreds of bridged chats);
  later syncs 20. The client saves rooms (last 15 events each), account data
  and the sync token in IndexedDB (`sync:<userId>`, `app/src/idb.js`) every
  minute and when hidden, and starts from that copy next time; a rejected token
  starts over. Cleared on sign-out.
- **Federation is off** (`federation_domain_whitelist: []`, listener only serves
  `client`). Registration off. Every invite is auto-accepted by the app (only the
  bridges can invite).
- **People are client-side.** `app/src/people.js` (pure, unit-tested) turns rooms
  into inbox items. Which rooms belong to which person is saved in Matrix
  **account data `fit.simas.inbox.people`**, so every device agrees:
  `{version, people: {pid: {name, rooms: [roomId], defaultRoom}}, dismissed: [roomsKey], replyWindowHours: 12}`.
  Rooms not in any person are shown as their own entry.
- **Room kinds**: `dm` / `group` / `connection` (bridge-bot chats, shown in
  Settings) / `space` (hidden). From `m.bridge` state: `com.beeper.room_type.v2`
  (`dm`, `group_dm`→group, `space`), else `com.beeper.room_type`, else iMessage's
  `channel['fi.mau.imessage.is_group']`, else member heuristics.
- **Merge suggestions**: same normalised name (diacritics folded: Eglė = Egle,
  `mantas_j` = `Mantas J.`) or same phone number in the ghost user id. He
  confirms each with "Combine" / "Not the same person".

### Which app a message goes out on (`chooseChannel`)

1. a channel he picked by hand in this thread (sticks until they write from another app)
2. where they last wrote to him, if within `replyWindowHours` (default 12 h, Settings)
3. the person's default app
4. where they last wrote / last used

Replying to a specific message always goes to that message's room. The
composer shows "Sending via <app> ▾" plus the reason.

## Status (as of 22 Nov 2026)

**Live.** Running on a **MacBook Air (13", mid 2013, 4 GB, Intel), macOS Big
Sur, Docker Desktop 4.24.2 with 2 GB**, in `~/Downloads/inbox-main/server`
(the Mac's user is `ilonaradaviciute`). Cloudflare Tunnel and Pages
(`Simanauskas/inbox`, `main`, root `app`) are set up; he signs in as `s`.
WhatsApp, Telegram, Messenger, Instagram connected and imported overnight
(Postgres wrote ~4.6 GB; while importing, Synapse sat at 100% of one core).
iMessage bridge runs against BlueBubbles Server 1.9.12 on the same Mac.
He updates server files by downloading single files from GitHub ("Download
raw file") into that folder and re-running `./setup.sh`.

**Moving to a VPS (22 Nov 2026):** the Air was too slow ("everything takes
too long"). Cherry Servers and Hetzner weren't selling; OVH only offered
Warsaw on VPS-3. He ordered **Hostika.lt VX3** (Lithuania, 6 vCPU, 10 GB,
100 GB NVMe, Ubuntu 24.04, €9.90 + VAT, billed quarterly, root password at
order, IPv4 only, no backups mentioned). Plan: `server/move.sh export` on
the Air → scp → `move.sh import` on the VPS (tested end to end in the
container: logins, messages, account data survive). iMessage stays on the
Air via BlueBubbles + a second tunnel `inbox-mac` (`mac/docker-compose.yml`,
`bb.simas.fit` → `http://host.docker.internal:1234`, WAF rule allowing only
the VPS IP), `BLUEBUBBLES_URL=https://bb.simas.fit`. Nightly `backup.sh`
(cron 04:17, keeps 7, excludes media). After the move: switch SSH to keys.

Open questions: he felt not everything synced (asked which app/chats — no
answer yet; note backfill only happens once per chat on a normal Synapse, so
scrolling up can't fetch older history). `curl https://matrix.simas.fit/_matrix/client/versions`
from the Air returned 404 while app traffic through the tunnel works —
unexplained. Notifications: told to turn on after imports finished.

If the Air is too slow day to day: a used **Mac mini M1/M2 with 16 GB** (M1
8 GB is enough for Inbox alone; avoid Intel 2018 and older), or move
`server/data` + the `inbox_pgdata` volume to a €4.50 Hetzner server and keep
the Mac only for BlueBubbles.

Not built yet: starting a brand-new chat from the app (use the bridge bot's
commands), recording voice messages.

## Working on it

- Work in a clone of `Simanauskas/inbox`; pushing `main` redeploys the app.
- Read `references/server.md` before touching `server/` or helping with setup,
  bridge logins or a bridge that misbehaves.
- Read `references/push.md` before touching notifications.
- Read `references/testing.md` before running or changing tests (the dev
  server, mock bridge, and the cloud-container quirks).
- After changing `app/src/people.js` run `npm test` in `app/`; after UI or
  client changes also run `dev/e2e.mjs`.
- Explain things to him in plain words; he's technical enough to run
  commands but isn't a developer. Give commands in separate copyable blocks.
