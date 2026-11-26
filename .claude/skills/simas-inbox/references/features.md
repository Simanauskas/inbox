# Inbox app features (app/src)

## Bridge capabilities first

Every bridged room has state **`com.beeper.room_features`** with the state key = the bridge id
(e.g. `matrix.simas.fit/whatsapp`, **not ""**). `room.features` comes from sync; for rooms cached before,
`client.loadFeatures` reads the full room state and picks it out (also power levels, topic,
disappearing timer). Offer a feature only where it says so. iMessage/SMS have no features event.

| | WhatsApp | Messenger | Instagram | Telegram |
|---|---|---|---|---|
| Edit | 15 min | 15 min, 5× | 15 min, 5× | any time |
| Delete for everyone | 2 days | ✓ | ✓ | ✓ |
| Polls | ✓ (`extev_polls: true`) | groups, multi-choice only | – | ✓ (`extev_polls: true`) |
| Location | ✓ | – | – | – |
| Disappearing messages | 1d/7d/90d | – | – | 1d…1y |
| Block / delete chat | ✓ | ✓ | ✓ | ✓ (+ delete for both) |
| Group: add/remove/rename/photo | ✓ (+ invite link) | ✓ | ✓ | add/remove/rename |
| Message requests | – | ✓ | ✓ | – |
| Reactions | any | any | any | only `allowed_reactions` |

## Chat (`ui/Thread.jsx`)

- **Message menu** (long-press / right-click): emoji row (his `quickReactions`; Telegram mapped via
  `emoji.js` `reactionsFor`/`allowedReaction`; ＋ panel) and labelled tools Reply · Edit · Forward ·
  Copy · Delete (finger-sized; fits a 320-px iPhone SE).
- **Edit**: ↑ in an empty box on the Mac or the menu; Enter saves, Esc cancels; m.replace with
  m.new_content (`client.edit`, `canEdit`). **Delete**: redaction (`client.redact`, `canDelete`).
- **Forward** (`ForwardSheet`) → `client.forward` copies the content (media reused by mxc) to the
  chosen person's usual app.
- **Formatting**: `format.js` `markdownToHtml` (*bold* _italic_ ~strike~ `code` ```block``` > quote,
  @mentions) → `formatted_body`; received HTML shown by `ui/Rich.jsx` (tag whitelist, http(s) links,
  mentions as @Name, scripts/styles dropped).
- **@mentions** in groups: `mentionQuery` → member list above the box (Tab/Enter picks) →
  `m.mentions` + matrix.to links.
- **"···" menu** next to the photo button when the room allows: Poll (`PollSheet` →
  `client.sendPoll`, MSC3381) and Location (`navigator.geolocation` → m.location; Info.plist text).
- **Polls**: `org.matrix.msc3381.poll.start/.response`; `pollOf`/`tallyPoll`; card shows results and
  who voted; tap to vote (`client.vote`).
- **Photos**: fixed aspect ratio; `useMedia` starts from `client.mediaCached` (no flash); tap → full
  screen `Viewer` (pinch, double-tap zoom, drag, swipe down / ✕ closes; iPhone: hold to save; web:
  Save). **Videos**: first frame as preview. **Voice**: MediaRecorder (WhatsApp needs Ogg/Opus,
  `ogg.js`; iMessage gets mp4 → ALAC CAF on sky); playback speed 1×/1.5×/2× remembered per device.
- **Ticks** (`deliveryStatus`): ✓ on sky, ✓✓ delivered (bridge bot receipt), coloured ✓✓ seen.
- **Typing** in the header; WhatsApp typing needs `fit.simas.inbox.viewing` events every 30 s while
  the chat is open (sky's patched WhatsApp bridge shows him online then — he agreed).
- **Call button**: hand-off only (wa.me, FaceTime audio/video, fb-messenger://, phone).
- **Banners**: save to contacts, list invite, plan "Add to calendar", message request (Accept/Delete).
- **Read receipts** only while really looking (`looking.js`).
- **Keyboard / layout**: Capacitor Keyboard resize none + `--kb` CSS var; `.page-layer` bottom =
  `--kb`; send button `preventDefault`s pointerdown (keyboard stays up); `ResizeObserver` keeps the
  newest message in view; `tapToDismissKeyboard` (touch outside a field, not in the composer).

## Contact page (`ui/Person.jsx`)

Name (rename), full iCloud card (view/edit), About (learned note + his own text; Enter saves), Lists,
apps (default / unlink / add a chat), **Chat settings** (`ui/ChatSettings.jsx`: disappearing
messages, block, delete chat).

## Group info (`ui/Group.jsx`, `group.js`)

Name/description (editable where power allows), members (Inbox name > card > app name; You, admins,
A–Z; Admin = power ≥ 50), tap a member → Message (existing chat, else `createDM(ghost)`; iMessage via
`pm +number` in its bot chat) / View contact / Add to contacts / Remove. Add members (people with a
1:1 chat on that app, or a number on WhatsApp → invite), WhatsApp invite link (`!wa invite-link`,
command + answer hidden by `isGroupCommand`), reaction notifications switch, chat settings (+ group
photo), Leave. `groupCaps` per bridge; rights from power levels (`canDo`).

## Inbox list (`ui/Inbox.jsx`)

- Filters in two rows: All · Unread · Groups · Lists · Archived (with count), then the app badges.
- Preview = newest message or reaction ("Laura reacted ❤️ to …"); own last message shows ticks.
- Unread = server counts; muted chats: grey count + 🔕. Pinned chats first (📌).
- Swipe left / two-finger swipe / right-click: **Pin · Mute · Read/Unread · Archive** (336 px).
- No `content-visibility` on rows (Safari left them blank under a page).
- On phones the inbox stays mounted under pages (`.base-layer`/`.page-layer`, App.jsx), so swipe-back
  (`useEdgeSwipeBack`, from the left 24 px) reveals it and it keeps its scroll.
- Web app shows "A new version of Inbox is ready. Update" (`useUpdateCheck`).

## Lists and invites (`lists.js`, `ui/Lists.jsx`)

Stored in the people account data: `lists {id: {name, members: [{key, room}]}}`, `invites {id: {listId,
text, when, minutes, place, sent, status, with}}`. Pick people → one message sent privately to each
via `chooseChannel`; replies shown per person; Confirm → note to the others (default "Ačiū, jau
susitariau - kitą kartą! 🎾") → Add to calendar.

## iPhone app specifics

Capacitor 8 (SPM), appId `fit.simas.inbox`, iOS 16+. Plugins: file-picker (photo library opens
directly), biometric-auth (Face ID lock), app-launcher, keyboard, push-notifications 8.1.3,
calendar. Info.plist usage texts: photos, camera, microphone, Face ID, calendars, location.
`.github/workflows/ios.yml`: archive unsigned → ad-hoc sign with entitlements → export with
automatic App Store signing (App Store Connect API key secrets) → TestFlight; build number = run number.
