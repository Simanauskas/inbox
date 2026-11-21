# Inbox push notifications (app closed)

Path: Synapse pusher → **Sygnal** (`matrixdotorg/sygnal`, `SYGNAL_CONF=/data/sygnal.yaml`,
reachable at `http://sygnal:5000/_matrix/push/v1/notify`) → browser push
service → service worker.

- **Keys**: setup.sh generates VAPID keys (`data/sygnal/vapid_private_key.pem`,
  `vapid_public_key.txt`). The public key, gateway URL and app id
  (`fit.simas.inbox.web`) are published in
  `/.well-known/matrix/client` under `fit.simas.inbox.push` via Synapse's
  `extra_well_known_client_content` — the app reads it from there, nothing to
  configure in Pages.
- **sygnal.yaml**: app `fit.simas.inbox.web`, `type: webpush`,
  `vapid_contact_email` (`PUSH_CONTACT_EMAIL`, default `push@<server>`),
  `allowed_endpoints`: `web.push.apple.com`, `fcm.googleapis.com`,
  `updates.push.services.mozilla.com`, `*.notify.windows.com`
  (+ `PUSH_EXTRA_ENDPOINT` for tests only).
- **Synapse → Sygnal** needs `ip_range_whitelist: [172.31.250.0/24]`
  (private ranges are blocked by default).

## App side

- `app/src/push.js`: `pushState` (`install` = iPhone not opened from Home
  Screen, `unsupported`, `unconfigured`, `denied`, `off`, `on`), `enablePush`
  (must run from a tap: permission → `pushManager.subscribe` with the VAPID key →
  `POST /pushers/set` with `data: {url, endpoint, auth, events_only: true}`,
  pushkey = p256dh), `disablePush`, `syncPush` on every start,
  `closeNotifications` when a room is read, `saveSessionForWorker` (session in
  IndexedDB `inbox/kv/session`, since the worker can't read localStorage).
- `app/public/sw.js` + `app/public/push-notify.js` (`InboxPush.notificationFromPush`,
  unit-tested): title = sender (· group name), body by msgtype, tag = room id,
  click opens `#/t/r:<roomId>` (posts to an open window or opens one), badge
  from `unread`.
- When push is on, in-app (tab-in-background) notifications step aside.

## Why it's built this way

- **Invites**: bridges invite you into a room for every imported chat; turning
  push on disables `.m.rule.invite_for_me` so connecting WhatsApp doesn't fire
  hundreds of "New chat" notifications.
- **Imported history**: bridgev2 backfill on a normal Synapse sends old
  messages as normal events with old timestamps and **no marker**, so they'd
  each push. The worker fetches the event (`/rooms/{id}/event/{id}`) and folds
  anything older than 15 min into one silent "Importing older messages…"
  notification (tag `inbox-import`). Every push must show *something*
  (`userVisibleOnly`), so they can't simply be dropped.
- `events_only: true` stops count-only pushes (which would force an empty notification).
- iPhone: Web Push only for Home Screen web apps (iOS 16.4+), permission only
  from a tap.
