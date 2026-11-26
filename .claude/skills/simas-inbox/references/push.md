# Inbox notifications

Synapse pushers → **Sygnal** (`http://sygnal:5000/_matrix/push/v1/notify`, `data/sygnal/sygnal.yaml`)
→ Apple (iPhone app) or the browsers' push services (Mac Dock app, Home Screen web app).
Synapse → Sygnal needs `ip_range_whitelist: [172.31.250.0/24]`.

## Two kinds of devices

| | iPhone app (TestFlight) | Web (Mac Dock app, browsers, Home Screen web app) |
|---|---|---|
| Pusher app_id | `fit.simas.inbox.ios` (pushkey = base64 of the APNs token) | `fit.simas.inbox.web` (pushkey = p256dh, `events_only: true`) |
| Sygnal app | `type: inbox_apns.InboxApnsPushkin` (`server/sygnal/inbox_apns.py`, mounted with `PYTHONPATH=/inbox-sygnal`), keyfile `/data/apns.p8`, key_id/team_id from .env, topic `fit.simas.inbox`, platform production (TestFlight = production) | `type: webpush`, VAPID keys in `data/sygnal/`, public key in `/.well-known/matrix/client` → `fit.simas.inbox.push` |
| App code | `native.js` `startNativePush` (asks once, registers every start, removes the old web pusher named "iPhone"), tap → `room_id` → chat, `clearNativeNotifications` on read, foreground = badge only | `push.js` (`enablePush` from a tap, `syncPush` each start), `public/sw.js` + `push-notify.js` |

- **iPhone build**: entitlement `aps-environment: production` (`App/App.entitlements`); the archive is
  unsigned, so the workflow ad-hoc signs it with the entitlements before the App Store export
  re-signs it. `UIBackgroundModes: remote-notification` for silent pushes. AppDelegate forwards the
  APNs token to Capacitor and handles silent "read" pushes.
- **APNs alert text** (`InboxApnsPushkin._get_payload_full`): title = sender (· group if the room name
  differs), body like the web ones (📷 Photo, 🎤 Voice message, "Reacted 👍 to your message"),
  `thread-id` = room, badge from counts. Our own types: `fit.simas.inbox.read` → silent
  `{read_rooms}` (sent as push_type background, priority 5); `fit.simas.inbox.alert` → plain alert
  "Inbox: …" (used by the Claude-token watch).
- setup.sh adds the iOS app to sygnal.yaml when `data/sygnal/apns.p8` exists and `APNS_KEY_ID`,
  `APNS_TEAM_ID` are set. The key came from the developer team's Keys page (never paste it in chat).

## Rules that decide what notifies (account @s)

- `.m.rule.invite_for_me` off (bridges invite to every imported chat).
- **Reactions**: `.m.rule.reaction` disabled; underride `fit.simas.inbox.reaction` = type m.reaction +
  `im.nheko.msc3664.related_event_match` {rel_type m.annotation, key sender, pattern @s} → only
  reactions to **his** messages. Needs `experimental_features.msc3664_enabled`. The app re-creates the
  rule on start (`ensureReactionRule`). Group info → "All reactions" adds underride
  `fit.simas.inbox.reactions-all.<roomId>` before it.
- **Mute** = room push rule with no notify (the bridges set these from the phone apps too; Inbox's
  Mute does the same). `mutedRoomIds` ignores Inbox's temporary rules below.
- **Chat he's actively in**: the app (`looking.js`: window in front + input in the last minute on
  Mac; on touch devices just in front) renews account data `fit.simas.inbox.active.<deviceId>`
  `{rooms, until: now+90 s}` every ~20 s; `readsync` keeps override rule
  `fit.simas.inbox.active.<roomId>` (no notify) while any device's `until` is ahead, and removes it
  when renewals stop. The service worker also skips the chat open on that device.

## Reading clears everywhere

- `server/readsync/readsync.py` (compose service `readsync`, syncs as @s): when his read receipt
  lands on a chat that had notifications, it sends Sygnal a `fit.simas.inbox.read` notification for
  the iOS pushers → the iPhone removes those chats' notifications (iOS rations silent pushes and
  doesn't wake an app swiped away). Open apps clear their own on receipts from other devices
  (`matrix.js` → `onRead`).
- Read receipts are only sent when he's really looking (`looking.js`), so a Mac window left open
  doesn't mark things read.

## Badge

- Badge = Synapse's count, which Sygnal passes on. `push.group_unread_count_by_room: false` ⇒ it counts
  unread **messages** (like the app). It also counts pending **invites**: dead invites (rooms deleted
  in a rebuild, "Can't join remote room") must be declined (`POST /rooms/{id}/leave`).
- Archived chats: `readsync` marks them read on the server unless a newer message arrived (the app
  does too). Hidden system chats (bridge bots, spaces) are marked read by the app.

## Synapse pusher quirk + watchdog

A pusher only looks at the oldest 20 notifications after its pointer; if those are all read, it skips
them and never advances — that device gets nothing until its app re-registers (it happened to the
iPhone, 24–26 Nov). `server/push-watchdog.sh` (cron every 5 min, installed by setup.sh) moves stuck
pointers on and restarts Synapse.

## Web push details

- Every web push must show something (`userVisibleOnly`): imported old messages (bridge backfill has no
  marker) are folded into one silent "Importing older messages…" (`inbox-import`, older than 15 min);
  the chat being read on that device is shown silently and closed at once.
- `events_only: true` stops count-only pushes. Alerts from the server carry a placeholder event_id so
  web push delivers them.
- iPhone web push works only for Home Screen web apps (iOS 16.4+) — superseded by the native app.
