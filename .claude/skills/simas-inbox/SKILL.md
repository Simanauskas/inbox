---
name: "simas-inbox"
description: Simas's own unified messaging app "Inbox" (repo Simanauskas/inbox, inbox.simas.fit, TestFlight iPhone app, Matrix server matrix.simas.fit on his VPS "sky"): one thread per person across WhatsApp, Telegram, Messenger, Instagram, iMessage and SMS via Synapse, mautrix bridges, BlueBubbles and Sygnal push, with Claude-written reply suggestions. Use whenever he mentions Inbox, sky, merging chats, which app replies go out on, bridge logins, missing chats or history, BlueBubbles, notifications or the badge, the TestFlight app, reply suggestions, polls, editing/deleting messages, groups, Lists, setup.sh / docker compose, the MacBook Air, the inbox tunnels, or messages not arriving, a person shown twice, unread counts, muting, archiving — even without saying "Inbox". Not for iCloud mail sorting (icloud-mail-rules), the training dashboard (simas-fit-update) or RAI Academy.
---

# Inbox — one thread per person across all his messaging apps

Built from 21 Nov 2026. One ad-free app for WhatsApp, Telegram, Messenger, Instagram, iMessage and
SMS. Each **person** is one thread with all their history; new messages go to their **default app**,
replies go back on **the app they last wrote from**. Self-hosted instead of Beeper; Viber dropped (no
workable bridge).

**His standing wish (26 Nov): give him everything the apps can do without being asked feature by
feature.** When a bridge offers something (`com.beeper.room_features`), build it.

## Where things are

| Thing | Where |
|---|---|
| Repo | **`Simanauskas/inbox`** (private). Pushing `main` deploys the web app (Cloudflare Pages) and, for changes under `app/`, builds a TestFlight version |
| Web app (React 18 + Vite, PWA, also in his Mac Dock) | `app/` → Pages root dir `app`, env `VITE_HOMESERVER=https://matrix.simas.fit`, domain `inbox.simas.fit` |
| iPhone app (Capacitor 8 shell) | `app/ios`, `app/capacitor.config.json`, `.github/workflows/ios.yml` |
| Server (Docker compose) | `server/` in the repo; deployed copy + data in **`/root/server`** on sky |
| Tests | `app/src/*.test.js` (`npm test`), `dev/` (local Synapse + mock bridge) |
| His account | **`@s:matrix.simas.fit`** |
| Public address | Cloudflare Tunnel **`inbox`**: `matrix.simas.fit` → `http://synapse:8008` |

- **sky** = his VPS (Hostika.lt VX3, Lithuania, 6 vCPU, 10 GB RAM — only ~2 GB free, 100 GB, Ubuntu
  24.04), IP 38.210.227.208, folder `/root/server`. SSH key-only; he uses `ssh inbox` from his **main
  Mac**. Claude Code sessions usually run **on sky itself** as root (`/root/inbox` = the repo, signed in
  to GitHub with repo + workflow scopes). Commands he runs from his Mac must be written as
  `ssh inbox '…'` (and `/root/.local/bin/claude`, which isn't on a plain ssh PATH).
- **MacBook Air** (2013, Big Sur, Messages on his Apple ID) runs only **BlueBubbles Server 1.9.12**
  (Private API off) + the `inbox-mac` tunnel (`bb.simas.fit`, WAF lets only sky in). Must stay awake.
  He doesn't want anything else installed there. SMS arrive via the iPhone's Text Message Forwarding
  to the Air (on since 24 Nov). BlueBubbles' API is behind Cloudflare: send a `curl/8.x` User-Agent.
- Nightly `backup.sh` 04:17 → `/root/server/backups`.

## Architecture

```
web / iPhone app ──HTTPS──▶ Synapse ◀─▶ mautrix bridges ─▶ WhatsApp / Telegram / Messenger / Instagram
                               │     ◀─▶ mautrix-imessage ─▶ BlueBubbles on the Air ─▶ iMessage + SMS
                               ├─▶ Sygnal ─▶ web push (Mac, browsers) + APNs (iPhone app)
                               └── services as @s: suggest (+ollama), transcribe (Whisper), readsync, contacts
```

- **No backend of its own for chat**: the app is a thin Matrix client (`app/src/matrix.js`); rooms are
  unencrypted (own server). Rooms/account data/sync token cached in IndexedDB. Federation and
  registration off; the app auto-accepts invites.
- **People are client-side** (`app/src/people.js`, pure, tested), saved in account data
  **`fit.simas.inbox.people`**: `{people: {pid: {name, rooms, defaultRoom, nameSource, about}}, dismissed,
  unlinked, archived: {key: ts}, pinned: {key: ts}, lists, invites, replyWindowHours, quickReactions,
  contactPromptsDismissed}`. Item keys: `p:<pid>` (person) / `r:<roomId>` (single room).
- **Room kinds** (`classifyRoom`): dm / group / connection (bridge-bot chats) / space. bridgev2 marks
  DMs `com.beeper.room_type: dm`; an unmarked room with a name or >1 other person is a group; iMessage
  uses `fi.mau.imessage.is_group`. Groups never sit inside a person. Unnamed groups are titled by
  members (`groupTitle`: "Jonas, Ugnė, Tomas +2", contact names first).
- **Networks** (`networks.js`): whatsapp, telegram, facebook, instagram, imessage, **sms**
  (`imessage-sms`), signal, matrix.
- **Combining** (`autoMerges`): same phone (last 9 digits) or same iCloud contact card ⇒ automatic;
  name-only ⇒ suggestion. Unlink adds the room to `unlinked`. A person can have two chats on one app;
  the header shows one badge per app.
- **Which app a message goes out on** (`chooseChannel`): 1) picked by hand in this thread 2) where they
  last wrote within `replyWindowHours` (12 h) 3) default app 4) last used. Replies go to that message's room.
- **Names** (his rule: he decides; default = iCloud contacts): typed in Inbox > phone book > app name.
  Phone book = compose service `contacts` (`server/contacts.py`, iCloud CardDAV with
  `ICLOUD_USER`/`ICLOUD_APP_PASSWORD` in server/.env — never in chat) → account data
  `fit.simas.inbox.contacts`. Contact page shows/edits the whole card (only changed fields, If-Match).

## What the app does (details in `references/features.md`)

- **Chat**: long-press/right-click → reactions (Telegram mapped to its allowed set) + Reply · Edit ·
  Forward · Copy · Delete-for-everyone (finger-sized, labelled). ↑ on the Mac edits the last message.
  Formatting (*bold* _italic_ ~strike~ `code` > quote) both ways, @mentions in groups, polls (vote +
  create), location, voice notes (player with progress line, 1×/1.5×/2×, **transcribed to text**),
  photos full screen (pinch/double-tap zoom, swipe down), HEIC → JPEG before sending, paste/drag
  files, plan banner "Add to calendar", reply-suggestion chips (Mac: ⇥ Tab).
- **Ticks**: ✓ on sky, ✓✓ delivered, coloured ✓✓ seen (no "Seen" text).
- **Contact page (WhatsApp-style)**: big photo, name, number, Chat · Call · Mute, Media/links/docs page,
  notifications, pin, disappearing messages, About (learned note), contact card, apps, groups in common,
  Lists, Block / Delete. **Group page**: members (message / add to contacts / remove), add members,
  invite link, rename, photo, reactions switch, leave.
- **iPhone share sheet**: "Inbox" share extension + people suggestions (message intents) — see features.md.
- **Inbox**: two filter rows (All · Unread · Groups · Lists · Archived / app badges), swipe or
  right-click → Pin · Mute · Read/Unread · Archive, message requests (Accept / Delete), Lists with
  invites ("Ačiū, jau susitariau - kitą kartą! 🎾").
- **Phone layout**: the inbox stays drawn in `.base-layer`; pages slide over it in `.page-layer`
  (edge swipe-back shows the inbox). Keyboard: Capacitor resize none + CSS `--kb`; send keeps focus;
  chat sticks to the newest message on resize; tap outside a field closes the keyboard.

## Notifications (details in `references/push.md`)

- iPhone app: **native APNs** through Sygnal (custom pushkin `server/sygnal/inbox_apns.py`, key on sky
  at `data/sygnal/apns.p8`, `APNS_KEY_ID`/`APNS_TEAM_ID` in .env). Mac/browsers: web push.
- Read anywhere ⇒ cleared everywhere (`readsync` → silent push to the iPhone; open apps clear
  themselves). While he's actively in a chat, no device buzzes for it (self-expiring server rule).
- Reactions notify only when they're to **his** messages (MSC3664), per group opt-in to all.
- Badge = unread **messages** (like the app); archived chats marked read on the server.
- `server/push-watchdog.sh` (cron, 5 min) unsticks Synapse pushers.

## Reply suggestions, plans, learned notes (details in `references/ai.md`)

- Service `suggest`: **Claude (Sonnet) on his subscription** via the server's Claude Code with a
  `claude setup-token` token (`SUGGEST_CLAUDE_TOKEN`) — his choice, 26 Nov; falls back to local
  gemma3:4b. Three different replies (respond / question / offer), **correct Lithuanian with
  diacritics** or English, his tone from `data/suggest/style.md` (server only) + a note per person.
- Learned notes (`fit.simas.inbox.profiles`): who each person is to him + category, from his chats.
- Token watch: daily check, alert + Settings card + top bar when it fails or nears its year.
- Plans agreed in chats (Claude) → "Add to calendar" (Apple Calendar "Simanauskas | Personal").
- **Voice messages → text**: service `transcribe` — Whisper large-v3-turbo on sky (audio never leaves
  sky) + Claude fixes misheard words; progress % and seconds left shown in the chat.
- Local ollama models unload quickly (only fallbacks now), leaving ~7 GB free for Whisper.

## Server, bridges, history (details in `references/server.md`)

- WhatsApp hides many numbers behind linked IDs: `server/lidmap.sh` (cron) publishes the bridge's
  lid→number map so those chats match contacts. Same full name on several iCloud cards = one person.
- Own patched bridge builds on sky (`.env` image overrides): Messenger (deep encrypted history),
  iMessage (full history, real dates, voice notes as ALAC CAF), WhatsApp (online-while-viewing hook).
- History can only be added when a bridge **creates** a chat. Refill = rebuild the chat, or
  `start-chat <id>` via the bridge bot for a missing one. Telegram syncs up to 200 chats.
- Messenger chats switched to encryption can lack history even with the backup PIN entered; his
  **Facebook data export** (JSON) is the source for those — files go to `/root/server/imports/`
  (private folder), import into the matching chats with original dates, skipping duplicates.

## Working on it

- Work in `/root/inbox` on sky; `git pull` first. Deploy server files by copying to `/root/server`
  and `docker compose up -d <service>`; keep repo and sky in step (setup.sh must reproduce sky).
- Before touching: `references/server.md` (server/bridges/history), `references/push.md`
  (notifications), `references/ai.md` (suggest service), `references/features.md` (app UI),
  `references/testing.md` (tests).
- No node on sky: run `npm test` / `npx vite build` in Docker `node:22-alpine`. For UI, render the
  component with made-up data in a small Vite harness (scratchpad) and screenshot with
  `mcr.microsoft.com/playwright:v1.49.1-noble` at iPhone size. For his screen recordings, cut frames
  with the `linuxserver/ffmpeg` image into contact sheets.
- Acting as him on sky: the double-puppet as_token in `data/synapse/doublepuppet.yaml` with
  `?user_id=@s:matrix.simas.fit`. Bridge commands: send to the bot's management room
  (`@facebookbot`, `@telegrambot`, …).
- **Never put real names, numbers, messages or account owners' names into tests, commits or the
  repo** (made-up data only). Secrets (app passwords, .p8 keys, tokens) never in chat: he types them
  into sky via `read -rsp`. Changes to sky's SSH config need his explicit OK.
- Explain in plain words; give commands in separate copyable blocks; report what was tested and what
  only he can verify on his phone.

## Open items

- Facebook/Messenger data export import (he requested the download 26 Nov; files go to
  `/root/server/imports/`, then import into the matching chats with original dates).
- Not built: GIF/sticker picker, view-once media, starred messages, grouping by learned categories,
  recent-photos grid. iMessage stays basic (no edit/delete/polls: Air on Big Sur, Private API off).
- Rotate the App Store Connect API key (advised).
