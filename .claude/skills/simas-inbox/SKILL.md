---
name: "simas-inbox"
description: Simas Simanauskas's own unified messaging app "Inbox" (repo Simanauskas/inbox, web app at inbox.simas.fit, native iPhone app via TestFlight, Matrix server matrix.simas.fit on his VPS "sky") — one thread per person merging his WhatsApp, Telegram, Messenger, Instagram, iMessage and SMS chats through a self-hosted Matrix (Synapse) server with mautrix bridges, BlueBubbles for iMessage/SMS and Sygnal for push notifications. Use whenever he mentions Inbox, inbox.simas.fit, matrix.simas.fit, sky, combining/merging his chats or messaging apps, a person's default channel or "reply on the app they wrote from", connecting or logging in to WhatsApp/Telegram/Messenger/Instagram/iMessage bridges, BlueBubbles, Sygnal or push notifications, the Inbox iPhone/TestFlight app, setup.sh / docker compose for the messaging server, the MacBook Air that runs BlueBubbles, the Cloudflare tunnels "inbox"/"inbox-mac", or a bridge that stopped working, messages or history not arriving, a person showing up twice, unread counts, muting, archiving — even if he doesn't say "Inbox". Not for email or iCloud mail sorting (icloud-mail-rules), his training dashboard (simas-fit-update), or the RAI Academy app (separate project, /root/rai-academy).
---

# Inbox — one thread per person across all his messaging apps

Built from 21 Nov 2026. One ad-free app for WhatsApp, Telegram, Messenger, Instagram, iMessage and
SMS, where each **person** is one thread with all their history, new messages go to that person's
**default app**, and replies go back on **the app they last wrote from**. Viber was dropped (no
workable bridge). He looked at Beeper and chose to self-host instead.

Repo: **`Simanauskas/inbox`** (private; pushing `main` deploys the web app on Cloudflare Pages and,
for changes under `app/`, builds a new TestFlight version).

| Thing | Where |
|---|---|
| Web app (React + Vite, PWA; also on his Mac Dock) | `app/` → Cloudflare Pages, root dir `app`, env `VITE_HOMESERVER=https://matrix.simas.fit`, domain `inbox.simas.fit` |
| iPhone app (Capacitor shell, TestFlight) | `app/ios`, `app/capacitor.config.json`, `.github/workflows/ios.yml` — see "iPhone app" |
| Server (Docker compose) | `server/` — `docker-compose.yml`, `setup.sh`, `contacts.py`, `backup.sh`, `move.sh`, own bridge builds in `server/meta`, `server/imessage`, `server/whatsapp` |
| Local test server + mock bridge + tests | `dev/`, `app/src/*.test.js` (`npm test`) |
| Guide for him | `README.md` |
| His account | **`@s:matrix.simas.fit`** (username `s`) |
| Public address | Cloudflare Tunnel **`inbox`**: `matrix.simas.fit` → `http://synapse:8008` |

## Where it runs (as of 25 Nov 2026)

- **sky** = his VPS (he named it that 23 Nov): Hostika.lt VX3 (Lithuania, 6 vCPU, 10 GB, 100 GB
  NVMe, Ubuntu 24.04), IP **38.210.227.208**, hostname inbox.simas.fit, folder **`/root/server`**.
  SSH key-only (`/etc/ssh/sshd_config.d/00-inbox.conf`); he uses `ssh inbox` from his **main Mac**.
  Nightly `backup.sh` 04:17 → `/root/server/backups` (also holds the safety copies made during
  the history rebuilds). Claude Code sessions often run **on sky itself** as root.
- sky is signed in to GitHub (`gh`, scopes repo + workflow) so pushes work from `/root/inbox`; he knows
  it can write all his repos and how to revoke it.
- **MacBook Air** (2013, Big Sur, Messages signed in to his Apple ID) only runs **BlueBubbles Server 1.9.12** (Private API **off**) and the
  `inbox-mac` tunnel (`bb.simas.fit` → `http://host.docker.internal:1234`, Cloudflare WAF lets only
  sky's IP in). sky's `.env` has `BLUEBUBBLES_URL=https://bb.simas.fit`. He does **not** want to
  install anything more on the Air. The Air must stay awake for iMessage/SMS.
- **SMS** reach Inbox only through the iPhone's **Text Message Forwarding → the MacBook Air**
  (turned on 24 Nov; SMS before that never reached the Air and can't be fetched).
- BlueBubbles' API is behind Cloudflare: Python's default User-Agent gets 403 — send `curl/8.x`.

## Architecture

```
web/iPhone app ──HTTPS──▶ Synapse ◀─▶ mautrix bridges ─▶ WhatsApp / Telegram / Messenger / Instagram
                             │     ◀─▶ mautrix-imessage ─▶ BlueBubbles on the Air ─▶ iMessage + SMS
                             └─▶ Sygnal ─▶ web push ─▶ phone / Mac
```

- **No backend of its own.** The app is a thin Matrix client (`app/src/matrix.js`). Rooms are
  unencrypted (own server). First sync 5 events/room, later 20; rooms (last 15 events), account data
  and the sync token are cached in IndexedDB.
- Federation and registration off; the app auto-accepts invites (only bridges invite).
- **People are client-side** (`app/src/people.js`, pure, unit-tested) and saved in account data
  **`fit.simas.inbox.people`**: `{people: {pid: {name, rooms, defaultRoom, nameSource}}, dismissed,
  unlinked, archived: {itemKey: ts}, replyWindowHours, quickReactions, contactPromptsDismissed}`.
- **Room kinds** (`classifyRoom`): `dm` / `group` / `connection` (bridge-bot chats, Settings) / `space`.
  bridgev2 bridges mark every DM `com.beeper.room_type: dm`; an **unmarked room with a name or >1
  other person is a group** (e.g. 2-person WhatsApp group "Revingis"); an unnamed one with one other
  person is a DM (Messenger keeps some 1:1 chats as unnamed "group" threads, thread_type 2). iMessage
  uses `fi.mau.imessage.is_group`. Groups are never shown inside a person even if saved there.
- **Networks** (`networks.js`): whatsapp, telegram, facebook, instagram, imessage, **sms**
  (`imessage-sms` protocol → green SMS badge; the iM filter includes SMS), signal, matrix.
- **Auto-combine** (`autoMerges`, App.jsx after sync): same phone number (last 9 digits), or same
  contact card matched by phone/email — and chats matching *that* card only by its unique full name
  join too (WhatsApp LIDs and Messenger/IG never give numbers). Name-only matches stay **suggestions**
  ("Combine" / "Not the same person"). Unlinking adds the room to `unlinked` (never re-combined).
- A person can have **two chats on one app** (an old Messenger thread + a newer encrypted one;
  iMessage on email + number). The thread shows them merged; the header shows **one badge per
  app** that sends to the current chat, else the newest one.

### Thread / message UI
- Header: one badge per app = where the message goes (tap to switch), "typing…", **📞 call button**
  (`calls.js`): no bridge carries calls, so it hands off: WhatsApp (`wa.me/<number>`), FaceTime
  audio/video, Messenger (`fb-messenger://user-thread/<id>`), Phone. Sheet is rendered with a portal
  (the header's backdrop blur traps fixed overlays).
- `chooseChannel`: 1) app picked by hand in this thread (until they write elsewhere) 2) where they
  last wrote, if within `replyWindowHours` (12 h) 3) default app 4) last used. Replies to a message go
  to that message's room.
- Press-and-hold / right-click a message → reactions bar (his `quickReactions`, ＋ panel), reply, copy.
- **Ticks** (`deliveryStatus`): ✓ server, ✓✓ delivered (bridge bot receipt), blue/"Seen" read.
- Input row: phone → 🖼 picker (+ 📷 camera button, hidden while typing); Mac → ⊕. **Paste (⌘V)**
  screenshots/files and **drag & drop** onto the box. Picked files wait in a preview strip with a
  caption field.
- **Voice messages**: mic when the field is empty → MediaRecorder; WhatsApp needs Ogg/Opus
  (`ogg.js` re-wraps WebM in the browser); iMessage gets mp4, which sky's iMessage bridge converts to
  **CAF with ALAC** (`server/imessage/voice-memo.patch`: this ffmpeg's CAF muxer can't hold Opus/AAC).
  With BlueBubbles Private API off, iMessage voice notes arrive as playable files, not waveform bubbles.
- **No notifications from the open chat**: `client.quietRooms` adds push rules
  `override/inbox-open-<roomId>` while a thread is open (these are *not* mutes — `mutedRoomIds`
  ignores them).
- **WhatsApp typing**: while a WhatsApp chat is open and the app is in front, the app sends a
  `fit.simas.inbox.viewing` room event every 30 s (`useWhatsAppViewing`, `client.viewing`, never shown
  in timelines); sky's WhatsApp bridge then shows him online (like WhatsApp Web) so WhatsApp sends
  typing; 75 s without a signal → offline. He agreed to appear online while a chat is open.
- Times are 24-hour (`hourCycle: 'h23'`). Swipe in from the left edge = back (`useEdgeSwipeBack`;
  its non-passive touchmove listener is attached only during an edge swipe, otherwise scrolling janks).

### Inbox list
- Search field in the top bar (✕ / tapping "Inbox" resets); 🔍 searches message text.
- Filters: All · Unread · app tags (SMS under iM) · Groups.
- Preview: newest message **or reaction** (`lastActivityEvent`): `Reacted 👍 to "…"`, `You reacted ❤️ to
  "…"`, in groups `Laura reacted ❤️ to "…"`. Your own last message shows ✓/✓✓/blue ✓✓ instead of "You:".
- **Unread = the server's count** (`unread_notifications.notification_count`), the same number
  notifications use. Unread chats never hide in the collapsed "no messages yet" row.
- **Muted chats** (room push rule without notify, or a room_id override; set by the bridges when he
  mutes on WhatsApp, or by Inbox's Mute): grey count bubble + 🔕, in the Unread filter, not in the app
  badge, no notifications. Their count comes from Synapse's MSC2654 `org.matrix.msc2654.unread_count`
  (enabled on sky 24 Nov via `experimental_features.msc2654_enabled`, counts only from then) or the
  loaded messages after his read receipt.
- **Swipe a chat left** (touch), **two-finger sideways swipe** (Mac trackpad; the browser's
  back/forward gesture is off via `overscroll-behavior-x: none`) or right-click: **Mute/Unmute**
  (Inbox-only room push rule), **Read/Unread** (`m.marked_unread` room account data), **Archive**
  ("Archived (N)" row at the top; a chat comes back on new activity).
- Hidden system chats (bridge bots, spaces) are marked read automatically so the badge matches; the
  app badge clears with `clearAppBadge` when nothing is unread.
- Web app update check (`useUpdateCheck`): "A new version of Inbox is ready. Update" — the Mac Dock app
  stays open for days and otherwise runs an old version.

### Notifications
Web push via Sygnal (see `references/push.md`). Native iPhone push (APNs) not built yet — he keeps the
Home Screen version for notifications. Reactions notify: on sky `.m.rule.reaction` is disabled and an
underride `fit.simas.inbox.reaction` (type m.reaction → notify) is set for @s, so muted chats stay
silent; push text "Reacted 👍 to your message". Group reactions to others' messages also notify.

### Names, phone book and contact cards (his rule: he decides; default = his iCloud contacts)
- Name priority: typed in Inbox (`nameSource: 'user'`) > phone book > the app's name.
- Phone book: compose service `contacts` (`server/contacts.py --loop`) reads **iCloud CardDAV**
  (`ICLOUD_USER` + `ICLOUD_APP_PASSWORD` in server/.env — never in chat), uploads
  `{v, source, contacts:[{id, n, p, e, d}]}` as a media file and points account data
  `fit.simas.inbox.contacts` at it. `n` = **first name + surname** from N (cards are often saved
  surname-first in FN). `d` = labelled phones/emails, company, title, birthday, address, url, note.
- Matching (`contacts.js`): phone (last 9 digits, LT "8 6…"), iMessage email, or a unique full name
  **in any word order**, emoji/diacritics ignored, middle name on the app OK if exactly one card fits.
- Contact page shows the whole card; **Edit** saves only the changed fields to iCloud
  (`{kind:'edit', href, changes}` → `edit_card`, If-Match etag, every other vCard line kept).
  "Add to contacts" / "Update contact card" (with a phone-number field) → `ConfirmCard`.

## Own bridge builds on sky (all in the repo, rebuilt with the scripts below)

Upstream images can't do what he needs, so sky runs patched builds (`.env` image overrides):
- **Messenger** `META_IMAGE=local/mautrix-meta:sky-history` ← `server/meta/build-meta.sh` +
  `deep-history.patch`: a *new* encrypted chat pages back through Messenger's encrypted backup up to
  `max_initial_messages` (10000), one chat at a time, 3–6 s between pages.
- **iMessage** `IMESSAGE_IMAGE=local/mautrix-imessage:sky` ← `server/imessage/build-imessage.sh` +
  `full-history.patch` (paginate BlueBubbles, skip emoji-less tapbacks, carry on past a failed event,
  `login_shared_secret: "as_token:<doublepuppet token>"` so his own backfilled messages keep real
  dates) + `voice-memo.patch` (MP4/WebM voice → ALAC CAF).
- **WhatsApp** `WHATSAPP_IMAGE=local/mautrix-whatsapp:sky` ← `server/whatsapp/build-whatsapp.sh` +
  `viewing.patch` (the `fit.simas.inbox.viewing` → online presence hook).
Each script pins the upstream commit the patch was made for (`*_REV`); `docker compose pull` skips
these images. Details and gotchas: `references/server.md`.

## History (done 23–24 Nov 2026)
- On a normal Synapse a bridge can add history **only when it creates a chat**; older messages can't be
  inserted later. Refilling a chat = rebuild it (delete its bridge DB rows + room link, recreate, swap
  room ids in `fit.simas.inbox.people`, leave the old room) — recipes in `references/server.md`.
- Messenger: 196 encrypted DMs rebuilt with full history (~18.9k msgs); 356 old photos/videos failed
  with 403 (Meta deleted the files; only a "Download your information" export could restore them).
  One long chat that started as a new encrypted chat on 24 Nov hit the 10,000 limit (`has_more=true`).
  A brand-new encrypted chat blocks that chat's new messages until its deep history is fetched
  (~5 min, then the bridge continues in the background).
- iMessage/SMS: all 721 chats (35.9k msgs) rebuilt with correct dates. Synapse rate-limit for @s
  lifted (`override_ratelimit` 0/0). `max_upload_size` 1G.
- Instagram: logged in with **cookies** (Safari private window → Copy as cURL → `login instagram`);
  password login from sky's datacenter IP hits a web checkpoint the bridge can't do, even with 2FA.
  Instagram may end the session again; repeat the cookie steps.

## iPhone app (native, TestFlight) — since 23 Nov 2026
- Capacitor 8 (`app/ios`, SPM, iPhone-only, iOS 16+), appId **fit.simas.inbox**, under a developer team
  he is Admin on (team id in `.github/workflows/ios.yml`; keep account owners' names out of the repo).
- `.github/workflows/ios.yml`: on pushes touching `app/**` (or by hand) builds on a GitHub Mac,
  archives **unsigned**, then exports with automatic **App Store** signing via the App Store Connect
  API key (secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`) and uploads to TestFlight; build number
  = run number. He installs via TestFlight (internal testing). He was advised to rotate the API key.
- Native bits (`app/src/native.js`, no-ops on the web): photo library opens directly (file-picker
  `pickMedia`), Face ID lock (Settings → Privacy), links handed to iOS (`@capacitor/app-launcher`),
  keyboard: `@capacitor/keyboard` resize **none** + CSS var `--kb` (native resize lagged and showed
  black around the keyboard), accessory bar hidden, page scrolling off. Service worker/web push off.
- Not built yet: native push (APNs key → Sygnal), recent-photos grid. "Default messaging app" (EU
  managed entitlement) deliberately not requested.

## Open items
- Messenger 403 media (needs Meta data export); the 10,000-limited Messenger chat's older history
  (rebuild with a higher limit overnight if he asks); native push; rotate the App Store Connect key.

## Working on it
- Work in `/root/inbox` (on sky) or a clone; `git pull` first. Pushing `main` deploys.
- Read `references/server.md` before touching `server/`, bridges, logins or history;
  `references/push.md` before notifications; `references/testing.md` before tests.
- After app changes: `npm test` in `app/` (Docker `node:22-alpine` on sky: no node installed) and
  `npx vite build`; for UI, render the component with made-up data in a small Vite harness and
  screenshot it with the `mcr.microsoft.com/playwright` image at iPhone size. Running `dev/` on sky
  would clash with the live Synapse on port 8008.
- Acting as him on sky: the double-puppet as_token in `data/synapse/doublepuppet.yaml` with
  `?user_id=@s:matrix.simas.fit` (account data, push rules, room state, read markers).
- **Never put real names, numbers or messages into tests, commits or the repo** (use made-up data);
  changes to sky's SSH config need his explicit OK.
- Explain things in plain words; give commands in separate copyable blocks.

## Lists and invites (25 Nov 2026)
- `app/src/lists.js` (pure, tested) + `ui/Lists.jsx`. Stored in the people account data:
  `lists: {id: {name, members: [{key, room}]}}` and `invites: {id: {listId, text, when (local
  "YYYY-MM-DDTHH:MM"), minutes, place, sent: [{key, room, ts}], at, status open|confirmed|closed, with}}`.
  Members/recipients are kept by item key + one room so combining chats doesn't lose them (`resolveMember`).
- Inbox list → "Lists" row → `#/lists` → `#/list/<id>`: tick people / Select all, one message, optional
  time + length + place; sends privately to each person via `chooseChannel`. The invite card shows each
  person's first reply after it went out (`repliesTo`). Confirm (there, or from `InviteBanner` in that
  person's chat) → "tell the others" with an editable note → "Add to your calendar?" → Google Calendar
  template link (ctz Europe/Vilnius) or an .ics (web only). Contact page has a Lists section.
- Planned next: AI reply suggestions in his style (chips + ghost text) via the Claude API from a service
  on sky — waiting for his OK on sending chat text to Anthropic, model choice (Opus 5.5 default vs
  Haiku 5.5) and an `ANTHROPIC_API_KEY` in server/.env; then detecting meetings agreed in normal chats
  to offer the calendar step.

## Reply suggestions and agreed plans (25 Nov 2026)
- Service `suggest` (profile `suggest`, `SUGGEST=1` in .env) + `ollama` (ollama/ollama:0.40.16, models
  gemma3:4b and bge-m3 in data/ollama). `server/suggest/suggest.py`: watches DM rooms via /sync as @s;
  memory = SQLite `data/suggest/suggest.db` of (their message → his reply) pairs with bge-m3 embeddings
  (~5.2k from history via `--backfill`, grows with every reply he sends). For a fresh inbound message
  it prompts Gemma with `data/suggest/style.md` (his style, on the server only — never in the repo) +
  the most similar past exchanges (same language) and writes 3 replies to room account data
  `fit.simas.inbox.suggest` {event_id, replies}. English chats get a separate English prompt (the
  small model drifts to Lithuanian otherwise). Skips automated messages; never learns/suggests his
  self-chat (`SUGGEST_SELF_NAMES`), commands, keys, IBANs, passwords (`SENSITIVE`). ~10–15 s each.
- App: chips above the composer (tap = fill the box), Mac ghost text "⇥ Tab" (`suggestionsFor`).
- Plans: when recent messages mention a time/day and someone confirmed, `detect_plan` asks Gemma for
  {agreed, title, date, time, minutes, place} (relative days from today in Vilnius) → room account data
  `fit.simas.inbox.plan` (offered once per room+start) → `PlanBanner` in the chat: "Add to calendar"
  (Apple Calendar via @ebarooni/capacitor-calendar, "Simanauskas | Personal" preselected; .ics on the
  web) / ✕. He chose free local models over a paid Claude API key.

## Group info (25 Nov 2026)
- Tapping a group's name/avatar opens `ui/Group.jsx` (Person.jsx routes kind 'group' there): name and
  description (editable via m.room.name / m.room.topic where allowed), members (`group.js` →
  `groupMembers`: Inbox name > contact card > app name; You, admins, A–Z; Admin = power ≥ 50).
- Tap a member: Message (opens their existing chat, else `createDM(ghost)` — bridgev2 turns a new
  room with an invited ghost into the 1:1 portal; iMessage sends `pm +number` to the iMessage bot
  chat), View contact, Add to contacts (ConfirmCard), Remove from group (kick; needs power).
- Add members: people with a 1:1 chat on the same app (`addable`), or a typed number on WhatsApp
  (`ghostFor`) → Matrix invite → bridge adds them on the app. Invite via link (WhatsApp): sends
  `!wa invite-link` in the group; the command and the bot's answer are hidden (`isGroupCommand`).
  Leave group = Matrix leave (bridge leaves on the app).
- Capabilities per bridge in `groupCaps`: WhatsApp all; Messenger/Instagram/Telegram add, remove,
  rename, leave; iMessage view-only. Rights come from the room's power levels (`canDo`).

## Notifications reaching every device (26 Nov 2026)
- Synapse quirk: a pusher only looks at the oldest 20 notifications after its pointer; if those
  are all read it skips them and never advances, so that device gets nothing until its app
  re-registers. The iPhone web-app pusher was stuck from 24 Nov this way. `server/push-watchdog.sh`
  (cron every 5 min, installed by setup.sh) moves such pointers on and restarts Synapse.
- Read receipts only when you're really looking (`app/src/looking.js`: window in front + input in
  the last minute on Mac; on touch devices just in front). The Mac window stays "visible" behind
  other apps and while he's out, which used to mark everything in the open chat read.
- No more server push rules for the open chat (`inbox-open-*`, they silenced the phone too): the
  app writes `quietRooms` to IndexedDB and the service worker shows nothing for that chat on that
  device only. Old rules are removed on start (`dropOpenChatRules`).
- The TestFlight app has no push of its own (APNs not built); phone notifications come from the
  home-screen web app's subscription.
