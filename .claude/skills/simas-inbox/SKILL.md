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

### Message UI
- **Press and hold** (or right-click) a message → reaction bar floating *above* it (below if near the
  top): his own emojis (Settings → Reactions, up to 8, `quickReactions` in the people account data,
  default 👍❤️😂😮😢🙏), ＋ (panel with ~100 emojis + "type any emoji"), reply, copy. Taps do nothing;
  text selection is off in the timeline on touch screens (use Copy).
- The ⌃ ⌄ ✓ bar above the iPhone keyboard is iOS Safari's form accessory bar: web apps can't hide it;
  only a native wrapper (e.g. Capacitor, needs an Apple developer account) could.
- **Ticks** on my messages (`deliveryStatus` in people.js): ✓ on the server, ✓✓ delivered (the bridge
  bot's read receipt — needs `matrix.delivery_receipts: true` / iMessage `bridge.delivery_receipts: true`,
  set by setup.sh), "Seen" under my newest message the other person's read receipt covers.
- **Which app to send on** is picked in the thread header: the app badges under the name are radio
  buttons; the current target is full colour + underlined, others dimmed; tap to switch (title/aria
  says why it was chosen). The input row is just attach · text · send/mic.
- **Voice messages**: mic button when the field is empty → MediaRecorder → `client.sendVoice`
  (m.audio + `org.matrix.msc3245.voice`, duration). Bridges check voice formats strictly: WhatsApp
  accepts only `audio/ogg; codecs=opus`; Telegram ogg/mpeg/mp4; Messenger/IG mp4 (+ogg with ffmpeg).
  So the app records Opus in WebM (Chrome, iPhone Safari) and re-wraps it as Ogg in the browser
  (`app/src/ogg.js`, no re-encoding); for iMessage it records audio/mp4. e2e checks the uploaded file
  with ffprobe. Max 5 min.
- Notification tap: the service worker stores `pendingOpen` in IndexedDB and the app opens that chat on
  start/visibility (iOS may launch the PWA without the #hash).
- **Photos with a caption**: picked files wait in a preview strip above the input ("Add a caption…");
  the caption goes with the first file (`sendFile(room, file, caption)`: body = caption, `filename` set).
- **No notifications from the open chat**: while a thread is visible, `client.quietRooms(rooms)` adds
  server push rules `override/inbox-open-<roomId>` (actions []) and removes them on leaving / app
  hidden (keepalive DELETE); leftovers are cleared on the next start (`localStorage inbox.quietRooms`).
- Online/last-seen status: not available (bridges don't pass presence; Synapse presence is off).

### Names & the phone book (his rule: he decides; default = his iCloud contacts)
- Priority: a name he typed in Inbox (`people[pid].nameSource = 'user'`, set by renaming on the
  contact page or editing the name when combining) > his phone book > the app's name.
  "Use the name from your contacts" clears `nameSource`.
- Phone book: `server/contacts.py` (cron every 15 min via `contacts.sh --install`, also run by
  setup.sh) reads contacts from BlueBubbles (`/api/v1/contact`), uploads them as a JSON media file
  as @s (double-puppet as_token) and points account data `fit.simas.inbox.contacts` {url,count,sha256}
  at it; only re-uploads on change. The app (`app/src/contacts.js`, `usePhoneBook` in App.jsx) caches
  it in IndexedDB and matches chats by phone (last 9 digits; LT "8 6…" handled), iMessage email, or an
  exact *unique full* name for Messenger/Instagram/Telegram. Same contact card ⇒ merge suggestion.
- Contact cards are never edited automatically: the contact page offers "Add to contacts" /
  "Update contact card" (vCard → iPhone's own create/add-to-existing sheet), and a chat shows a
  dismissible "Save X to your contacts?" only if both sides wrote ≥3 messages.

### Inbox list
- Search field has an ✕ (and tapping the "Inbox" title) that clears search + filter and scrolls to the top.
- Filter row: All · Unread · short app tags (WA/TG/FB/IG/iM, borderless) · Groups — fits one line.
- App tags sit right after the name (max 2, else first + "+N"); the preview gets the full line.
- WhatsApp "linked IDs" (`whatsapp_lid-…` ghosts, WhatsApp hiding numbers) are not phone numbers:
  `phoneFromUser` ignores them. Readable names for those come from the bridge's
  `displayname_template` = contact name (setup.sh).

### Which app a message goes out on (`chooseChannel`)

1. a channel he picked by hand in this thread (sticks until they write from another app)
2. where they last wrote to him, if within `replyWindowHours` (default 12 h, Settings)
3. the person's default app
4. where they last wrote / last used

Replying to a specific message always goes to that message's room. The
composer shows "Sending via <app> ▾" plus the reason.

## Status (as of 22 Nov 2026, evening)

**Live on a VPS: Hostika.lt VX3** (Lithuania; 6 vCPU, 10 GB, 100 GB NVMe,
Ubuntu 24.04), IP **38.210.227.208**, hostname inbox.simas.fit. Server folder
**`/root/server`** (moved with `move.sh`; logins, chats and account data came
along). SSH is key-only (`/etc/ssh/sshd_config.d/00-inbox.conf`). He works from his
**main Mac** (not the Air): `ssh inbox` (alias in `~/.ssh/config`, user root).
The Air's key is also authorized. Don't ask him to run anything on the Air
except BlueBubbles/`~/inbox-mac` matters — copying commands to it is painful. Nightly `backup.sh` at 04:17 into
`/root/server/backups`. Cloudflare tunnel `inbox` now connects from the VPS.

The **MacBook Air (2013, Big Sur, Docker Desktop 4.24.2)** now only runs
BlueBubbles Server 1.9.12 + the `inbox-mac` tunnel (`~/inbox-mac`,
`bb.simas.fit` → `http://host.docker.internal:1234`, WAF rule: only the VPS IP
may reach bb.simas.fit). Its old server in `~/Downloads/inbox-main/server`
is stopped and must stay stopped. VPS `.env` has
`BLUEBUBBLES_URL=https://bb.simas.fit`.

Gotchas from the move: the Air had no SSH key at first; disabling password
login before testing the key locked him out (fixed by Hostika "Reinstall").
Always test with `ssh -o PasswordAuthentication=no ... 'echo KEY WORKS'` first.

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
