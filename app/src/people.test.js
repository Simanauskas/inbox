import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildModel, suggestions, mergePeople, chooseChannel, mergedTimeline, normName, unlinkRoom, stripReply, renamePerson } from './people.js'

const ME = '@simas:x'
const H = 3600_000
let n = 0
const msg = (sender, ts, body = 'hi') => ({ event_id: `$${++n}`, type: 'm.room.message', sender, origin_server_ts: ts, content: { msgtype: 'm.text', body } })

function room(id, net, ghost, name, events, extra = {}) {
  return {
    id, membership: 'join', name, heroes: [ghost, `@${net}bot:x`], joinedCount: 3,
    members: { [ghost]: { displayname: name, membership: 'join' } },
    bridge: { bridgebot: `@${net}bot:x`, protocol: { id: net }, 'com.beeper.room_type': 'dm' },
    timeline: events, receipts: {}, notificationCount: 0, reachedStart: true, ...extra,
  }
}

const now = 1_000_000_000_000
const rooms = {
  wa: room('wa', 'whatsapp', '@whatsapp_37061234567:x', 'Rokas Petrauskas', [msg('@whatsapp_37061234567:x', now - 50 * H), msg(ME, now - 49 * H)]),
  tg: room('tg', 'telegram', '@telegram_1:x', 'Rokas Petrauskas', [msg('@telegram_1:x', now - 2 * H)]),
  ig: room('ig', 'instagram', '@instagram_m:x', 'mantas_j', [msg('@instagram_m:x', now - 30 * H)]),
  tgm: room('tgm', 'telegram', '@telegram_2:x', 'Mantas J.', [msg('@telegram_2:x', now - 40 * H)]),
  solo: room('solo', 'facebook', '@facebook_9:x', 'Tomas', [msg('@facebook_9:x', now - 90 * H)]),
}

test('normName folds diacritics and punctuation', () => {
  assert.equal(normName('Eglė Žemaitė'), 'egle zemaite')
  assert.equal(normName('mantas_j'), normName('Mantas J.'))
})

test('suggests merges by name across apps', () => {
  const model = buildModel(rooms, {}, ME, null)
  const s = suggestions(model)
  const keys = s.map((x) => x.rooms.join(','))
  assert.deepEqual(keys.sort(), ['ig,tgm', 'tg,wa'])
})

test('merged person shows one inbox entry with both apps', () => {
  const model = buildModel(rooms, {}, ME, null)
  const s = suggestions(model).find((x) => x.rooms.includes('wa'))
  const { config } = mergePeople(null, s.members, 'Rokas', 'wa')
  const m2 = buildModel(rooms, {}, ME, config)
  const rokas = m2.items.filter((i) => i.name === 'Rokas')
  assert.equal(rokas.length, 1)
  assert.deepEqual(rokas[0].networks.sort(), ['telegram', 'whatsapp'])
  assert.equal(m2.items.length, 4)
  assert.equal(suggestions(m2).length, 1)
})

test('reply goes where they last wrote, within the window', () => {
  const item = { rooms: ['wa', 'tg'], defaultRoom: 'wa' }
  assert.deepEqual(chooseChannel(item, rooms, ME, { now }).roomId, 'tg')
  // 20h later the Telegram message is outside the 12h window -> default
  assert.equal(chooseChannel(item, rooms, ME, { now: now + 20 * H }).roomId, 'wa')
  assert.equal(chooseChannel(item, rooms, ME, { now: now + 20 * H }).reason, 'default')
})

test('a manual pick sticks until they write from another app', () => {
  const item = { rooms: ['wa', 'tg'], defaultRoom: 'wa' }
  const override = { roomId: 'wa', ts: now }
  assert.equal(chooseChannel(item, rooms, ME, { now, override }).roomId, 'wa')
  const r2 = { ...rooms, tg: { ...rooms.tg, timeline: [...rooms.tg.timeline, msg('@telegram_1:x', now + H)] } }
  assert.equal(chooseChannel(item, r2, ME, { now: now + H, override }).roomId, 'tg')
})

test('no default: falls back to where they last wrote', () => {
  const item = { rooms: ['wa', 'tg'], defaultRoom: null }
  const r = chooseChannel(item, rooms, ME, { now: now + 100 * H })
  assert.equal(r.roomId, 'tg')
  assert.equal(r.reason, 'last')
})

test('merged timeline interleaves by time and respects unloaded history', () => {
  const item = { rooms: ['wa', 'tg'] }
  const t = mergedTimeline(item, rooms)
  assert.deepEqual(t.entries.map((e) => e.roomId), ['wa', 'wa', 'tg'])
  const partial = { ...rooms, tg: { ...rooms.tg, reachedStart: false } }
  const t2 = mergedTimeline(item, partial)
  // telegram has older history not loaded yet -> hide WhatsApp messages older than it
  assert.deepEqual(t2.entries.map((e) => e.roomId), ['tg'])
  assert.equal(t2.hasMore, true)
})

test('unlinking the last room removes the person', () => {
  const { config, personId } = mergePeople(null, [{ rooms: ['wa'] }], 'R', 'wa')
  const c2 = unlinkRoom(config, personId, 'wa')
  assert.deepEqual(c2.people, {})
})

test('stripReply removes quoted fallback', () => {
  assert.equal(stripReply('> <@a:x> hello\n\nthanks'), 'thanks')
  assert.equal(stripReply('plain'), 'plain')
})

test('bridgev2 room types: group DMs and spaces are not people', () => {
  const base = rooms.wa
  const gdm = { ...base, id: 'gdm', bridge: { ...base.bridge, 'com.beeper.room_type': 'dm', 'com.beeper.room_type.v2': 'group_dm' } }
  const space = { ...base, id: 'sp', roomType: 'm.space', bridge: null, heroes: ['@whatsappbot:x'] }
  const fb = { ...rooms.solo, id: 'fbgo', bridge: { ...rooms.solo.bridge, protocol: { id: 'facebookgo' } } }
  const m = buildModel({ gdm, sp: space, fbgo: fb }, {}, ME, null)
  assert.equal(m.info.gdm.kind, 'group')
  assert.equal(m.info.sp.kind, 'space')
  assert.equal(m.connections.length, 0)
  assert.equal(m.info.fbgo.network, 'facebook')
  // a WhatsApp group with only one other person left is still a group, not a DM with them
  const g2 = { ...base, id: 'g2', name: 'Revingis', bridge: { ...base.bridge, 'com.beeper.room_type': undefined, channel: { id: '1203@g.us' } } }
  assert.equal(buildModel({ g2 }, {}, ME, null).info.g2.kind, 'group')
  // ...but Messenger's unnamed 2-person "group" threads are really 1:1 chats
  const m1 = { ...base, id: 'm1', name: null, bridge: { ...base.bridge, 'com.beeper.room_type': undefined, channel: { id: '7723' } } }
  assert.equal(buildModel({ m1 }, {}, ME, null).info.m1.kind, 'dm')
})

test('iMessage: is_group flag and escaped phone numbers', async () => {
  const { phoneFromUser } = await import('./networks.js')
  assert.equal(phoneFromUser('@imessage_37061234567:x'), '37061234567')
  assert.equal(phoneFromUser('@imessage_tel=3a=2b37061234567:x'), '37061234567')
  assert.equal(phoneFromUser('@imessage_rokas=40gmail.com:x'), null)
  const im = (id, isGroup) => ({ ...rooms.wa, id, heroes: ['@imessage_37061234567:x', '@imessagebot:x'],
    bridge: { bridgebot: '@imessagebot:x', protocol: { id: 'imessage' }, channel: { 'fi.mau.imessage.is_group': isGroup } } })
  const m = buildModel({ a: im('a', false), b: im('b', true) }, {}, ME, null)
  assert.equal(m.info.a.kind, 'dm')
  assert.equal(m.info.a.network, 'imessage')
  assert.equal(m.info.a.phone, '37061234567')
  assert.equal(m.info.b.kind, 'group')
})

test('push payload becomes a readable notification', async () => {
  await import('../public/push-notify.js')
  const { notificationFromPush } = globalThis.InboxPush
  const dm = notificationFromPush({ room_id: '!r:x', event_id: '$e', sender_display_name: 'Rokas', room_name: 'Rokas', content: { msgtype: 'm.text', body: '> <@a:x> hi\n\nSauna at 7?' } })
  assert.equal(dm.title, 'Rokas')
  assert.equal(dm.options.body, 'Sauna at 7?')
  assert.equal(dm.options.tag, '!r:x')
  assert.equal(dm.options.data.hash, '#/t/' + encodeURIComponent('r:!r:x'))
  const grp = notificationFromPush({ room_id: '!g:x', sender_display_name: 'Ilona', room_name: 'Hyrox crew', content: { msgtype: 'm.image', body: 'x.jpg' } })
  assert.equal(grp.title, 'Ilona · Hyrox crew')
  assert.equal(grp.options.body, '📷 Photo')
  assert.equal(notificationFromPush({ type: 'm.room.member', sender: '@whatsappbot:x', content: { membership: 'invite' } }).options.body, 'New chat')
})

test('bridge app tags are dropped from names', async () => {
  const { cleanName } = await import('./people.js')
  assert.equal(cleanName('Mel (WA)'), 'Mel')
  assert.equal(cleanName('Rokas Petrauskas (Telegram)'), 'Rokas Petrauskas')
  assert.equal(cleanName('Team (Work)'), 'Team (Work)')
  assert.equal(normName('Mel (WA)'), normName('Mel'))
})

test('delivery status: sent, delivered by the bridge, seen by them', async () => {
  const { deliveryStatus } = await import('./people.js')
  const mine = msg(ME, now, 'hi')
  const theirs = msg('@whatsapp_1:x', now + 1000, 'yo')
  const room = { timeline: [mine, theirs], receipts: {}, bridge: { bridgebot: '@whatsappbot:x' } }
  assert.equal(deliveryStatus(room, mine, ME), 'sent')
  room.receipts['@whatsappbot:x'] = mine.event_id
  assert.equal(deliveryStatus(room, mine, ME), 'delivered')
  room.receipts['@whatsapp_1:x'] = mine.event_id
  assert.equal(deliveryStatus(room, mine, ME), 'seen')
  const later = msg(ME, now + 2000, 'later')
  room.timeline.push(later)
  assert.equal(deliveryStatus(room, later, ME), 'sent', 'a receipt on an earlier message does not cover later ones')
  assert.equal(deliveryStatus(room, { ...later, status: 'sending' }, ME), 'sending')
})

test('WhatsApp linked IDs are not phone numbers', async () => {
  const { phoneFromUser } = await import('./networks.js')
  assert.equal(phoneFromUser('@whatsapp_lid-210427829035057:x'), null)
  assert.equal(phoneFromUser('@whatsapp_37061234567:x'), '37061234567')
})

test('phone book: names, matching and merging', async () => {
  const { indexContacts, normalizePhone, missingFromCard, vcard } = await import('./contacts.js')
  const { clearCustomName } = await import('./people.js')
  assert.equal(normalizePhone('8 612 34567'), '37061234567')
  assert.equal(normalizePhone('+370 (612) 34 567'), '37061234567')
  assert.equal(normalizePhone('612 34567'), '37061234567')
  const idx = indexContacts({ contacts: [
    { n: 'Rokas P. (tennis)', p: ['8 612 34567'], e: ['rokas@example.com'] },
    { n: 'Mantas Jonaitis', p: [] },
    { n: 'Tomas', p: [] },
  ] })
  const r = {
    wa: room('wa', 'whatsapp', '@whatsapp_37061234567:x', 'Rocky 💪', [msg('@whatsapp_37061234567:x', now)]),
    im: room('im', 'imessage', '@imessage_rokas=40example.com:x', 'rokas@example.com', [msg('@imessage_rokas=40example.com:x', now - H)]),
    ig: room('ig', 'instagram', '@instagram_9:x', 'Mantas Jonaitis', [msg('@instagram_9:x', now - 2 * H)]),
    fb: room('fb', 'facebook', '@facebook_7:x', 'Tomas', [msg('@facebook_7:x', now - 3 * H)]),
  }
  const m = buildModel(r, {}, ME, null, idx)
  const name = (id) => m.items.find((i) => i.rooms.includes(id)).name
  assert.equal(name('wa'), 'Rokas P. (tennis)', 'phone book beats the name they chose on WhatsApp')
  assert.equal(name('im'), 'Rokas P. (tennis)', 'iMessage email matched to the same card')
  assert.equal(name('ig'), 'Mantas Jonaitis', 'unique full name matches on Instagram')
  assert.equal(name('fb'), 'Tomas', 'single first names are never used to match')
  assert.equal(m.info.fb.contact, null)
  const s = suggestions(m)
  assert.ok(s.some((x) => x.rooms.includes('wa') && x.rooms.includes('im')), 'same contact card → suggest combining')
  // a name you typed wins over the phone book, and can be reset
  const p = m.items.find((i) => i.rooms.includes('wa'))
  const c1 = renamePerson(null, p, 'Rokas')
  const m2 = buildModel(r, {}, ME, c1, idx)
  assert.equal(m2.items.find((i) => i.rooms.includes('wa')).name, 'Rokas')
  const m3 = buildModel(r, {}, ME, clearCustomName(c1, m2.items.find((i) => i.rooms.includes('wa'))), idx)
  assert.equal(m3.items.find((i) => i.rooms.includes('wa')).name, 'Rokas P. (tennis)')
  // what the apps know that the card doesn't
  assert.deepEqual(missingFromCard(idx.list[0], { phones: ['37061234567', '37069999999'], emails: ['ROKAS@example.com'] }), { phones: ['37069999999'], emails: [] })
  // cards saved surname first (with an emoji), and a middle name the card doesn't have
  const { contactFor } = await import('./contacts.js')
  const idx2 = indexContacts({ contacts: [
    { n: 'Kazlauskas Jonas🏦', p: ['+37061111111'] },
    { n: 'Petraitis Ąžuolas', p: [] },
    { n: 'Vaitkus Rimas 🎾', p: [] },
    { n: 'Vaitkus Rimas', p: [] },
  ] })
  assert.equal(contactFor(idx2, { names: ['Jonas Kazlauskas'] })?.n, 'Kazlauskas Jonas🏦', 'word order and emoji ignored')
  assert.equal(contactFor(idx2, { names: ['Azuolas Mantas Petraitis'] })?.n, 'Petraitis Ąžuolas', 'middle name on the app only')
  assert.equal(contactFor(idx2, { names: ['Rimas Vaitkus'] }), null, 'two cards with that name: no guess')
  assert.equal(contactFor(idx2, { names: ['Rimas'] }), null)
  assert.match(vcard({ name: 'Jonas Bernotas', phones: ['37065666144'] }), /FN:Jonas Bernotas\r\nN:Bernotas;Jonas;;;\r\nTEL;TYPE=CELL:\+37065666144/)
})

test('reaction emojis: split typed text into whole emojis', async () => {
  const { splitEmojis, quickReactions, DEFAULT_REACTIONS } = await import('./emoji.js')
  assert.deepEqual(splitEmojis('🔥 👍🏽 ❤️ab🇱🇹'), ['🔥', '👍🏽', '❤️', '🇱🇹'])
  assert.deepEqual(quickReactions({}), DEFAULT_REACTIONS)
  assert.deepEqual(quickReactions({ quickReactions: ['🔥'] }), ['🔥'])
})

test('auto-combine: same number or same contact card by phone/email, never by name alone', async () => {
  const { indexContacts } = await import('./contacts.js')
  const { autoMerges, applyAutoMerges, unlinkRoom } = await import('./people.js')
  const idx = indexContacts({ contacts: [{ id: 'card1', n: 'Jonas Kazlauskas', p: ['+37061111111'], e: ['jonas@example.com'] }, { id: 'card2', n: 'Rimas Vaitkus', p: [] }] })
  const r = {
    ime: room('ime', 'imessage', '@imessage_jonas=40example.com:x', 'Jonas Kazlauskas', [msg('@imessage_jonas=40example.com:x', now)], { bridge: { bridgebot: '@imessagebot:x', protocol: { id: 'imessagego' }, channel: { 'fi.mau.imessage.is_group': false } } }),
    imp: room('imp', 'imessage', '@imessage_+37061111111:x', 'Jonas Kazlauskas', [msg('@imessage_+37061111111:x', now - H)], { bridge: { bridgebot: '@imessagebot:x', protocol: { id: 'imessagego' }, channel: { 'fi.mau.imessage.is_group': false } } }),
    sms: room('sms', 'imessage', '@imessage_+37061111111:x', 'Jonas Kazlauskas', [msg('@imessage_+37061111111:x', now - 2 * H)], { bridge: { bridgebot: '@imessagebot:x', protocol: { id: 'imessage-sms' }, channel: { 'fi.mau.imessage.is_group': false } } }),
    fb: room('fb', 'facebook', '@facebook_7:x', 'Rimas Vaitkus', [msg('@facebook_7:x', now)]),
    ig: room('ig', 'instagram', '@instagram_9:x', 'Rimas Vaitkus', [msg('@instagram_9:x', now)]),
    wa: room('wa', 'whatsapp', '@whatsapp_lid-123:x', 'Jonas Kazlauskas', [msg('@whatsapp_lid-123:x', now)]),
  }
  const m = buildModel(r, {}, ME, null, idx)
  const merges = autoMerges(m)
  assert.equal(merges.length, 1, 'only the number/email group, not the name-only one')
  assert.deepEqual(merges[0].members.flatMap((x) => x.rooms).sort(), ['ime', 'imp', 'sms', 'wa'], 'WhatsApp joins by the card name once a number ties the card')
  const cfg = applyAutoMerges(null, merges)
  const m2 = buildModel(r, {}, ME, cfg, idx)
  const jonas = m2.items.find((i) => i.rooms.includes('ime'))
  assert.deepEqual([...jonas.rooms].sort(), ['ime', 'imp', 'sms', 'wa'])
  assert.equal(jonas.name, 'Jonas Kazlauskas')
  assert.equal(autoMerges(m2).length, 0, 'nothing left to do')
  // unlinking by hand sticks
  const cfg2 = unlinkRoom(cfg, jonas.personId, 'sms')
  assert.equal(autoMerges(buildModel(r, {}, ME, cfg2, idx)).length, 0)
})

test('call hand-off: WhatsApp, FaceTime, phone and Messenger links', async () => {
  const { callOptions } = await import('./calls.js')
  const info = {
    wa: { network: 'whatsapp', phone: null },
    im: { network: 'imessage', phone: '37061111111' },
    ime: { network: 'imessage', email: 'jonas@example.com' },
    fb: { network: 'facebook', remote: '@facebook_1473:x' },
  }
  const o = callOptions({ rooms: ['wa', 'im', 'ime', 'fb'], contact: { p: ['8 611 11111'] } }, info)
  assert.deepEqual(o.map((x) => x.href), [
    'https://wa.me/37061111111', 'facetime-audio://+37061111111', 'facetime://+37061111111',
    'fb-messenger://user-thread/1473', 'tel:+37061111111',
  ])
  assert.deepEqual(callOptions({ rooms: ['ime'] }, info).map((x) => x.href), ['facetime://jonas@example.com'])
  assert.deepEqual(callOptions({ rooms: ['x'] }, { x: { network: 'telegram' } }), [])
})

test('chat list: reactions show as "Reacted 👍 to …" and archived chats come back on new activity', async () => {
  const { previewText, setArchived } = await import('./people.js')
  const target = msg(ME, now - 2 * H, 'yeah these are the domains')
  const react = { event_id: '$r', type: 'm.reaction', sender: '@whatsapp_1:x', origin_server_ts: now - H, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target.event_id, key: '👍' } } }
  const r = { wa: room('wa', 'whatsapp', '@whatsapp_1:x', 'Michael', [target, react]) }
  r.wa.byId = { [target.event_id]: target, $r: react }
  const m = buildModel(r, {}, ME, null)
  const it = m.items[0]
  assert.equal(it.lastEvent.type, 'm.reaction', 'a reaction moves the chat up')
  assert.equal(previewText(it.lastEvent, ME, r.wa), 'Reacted 👍 to "yeah these are the domains"')
  assert.equal(previewText({ ...react, sender: ME }, ME, r.wa), 'You reacted 👍 to "yeah these are the domains"')
  // archive, then a new message brings it back
  const cfg = setArchived(null, it, true)
  assert.equal(buildModel(r, {}, ME, cfg).items[0].archived, true)
  r.wa.timeline = [...r.wa.timeline, msg('@whatsapp_1:x', Date.now() + 1000)]
  assert.equal(buildModel(r, {}, ME, cfg).items[0].archived, false)
})

test('muted chats: unread count shown separately, not in the notifying count', async () => {
  const { mutedRoomIds } = await import('./people.js')
  const a = room('a', 'whatsapp', '@whatsapp_1:x', 'Eiguliu 5', [msg(ME, now - 3 * H), msg('@whatsapp_1:x', now - 2 * H), msg('@whatsapp_1:x', now - H)])
  a.receipts = { [ME]: a.timeline[0].event_id }
  const b = room('b', 'whatsapp', '@whatsapp_2:x', 'Rokas', [msg('@whatsapp_2:x', now)])
  b.notificationCount = 1
  const accountData = { 'm.push_rules': { global: { room: [{ rule_id: 'a', actions: [], enabled: true }] } } }
  assert.deepEqual([...mutedRoomIds(accountData)], ['a'])
  const m = buildModel({ a, b }, accountData, ME, null)
  const ia = m.items.find((i) => i.rooms.includes('a'))
  const ib = m.items.find((i) => i.rooms.includes('b'))
  assert.equal(ia.muted, true)
  assert.equal(ia.unread, 0, 'muted chats never count towards notifications / the app badge')
  assert.equal(ia.mutedUnread, 2, 'but their unread messages are counted for the grey bubble')
  a.unreadCount = 16
  assert.equal(buildModel({ a, b }, accountData, ME, null).items.find((i) => i.rooms.includes('a')).mutedUnread, 16, "the server's count wins when higher")
  assert.equal(ib.unread, 1)
  assert.equal(ib.muted, false)
})

test('group reactions say who; Inbox\'s own "chat is open" rule is not a mute', async () => {
  const { previewText, mutedRoomIds } = await import('./people.js')
  const target = msg(ME, now - H, 'Kaip isivaizduoju')
  const react = { event_id: '$g', type: 'm.reaction', sender: '@whatsapp_7:x', origin_server_ts: now, content: { 'm.relates_to': { event_id: target.event_id, key: '❤️' } } }
  const g = { byId: { [target.event_id]: target }, timeline: [target, react], members: { '@whatsapp_7:x': { displayname: 'Laura (WA)' } } }
  assert.equal(previewText(react, ME, g, true), 'Laura reacted ❤️ to "Kaip isivaizduoju"')
  assert.equal(previewText(react, ME, g, false), 'Reacted ❤️ to "Kaip isivaizduoju"')
  const ad = { 'm.push_rules': { global: { override: [
    { rule_id: 'inbox-open-!a', actions: [], conditions: [{ kind: 'event_match', key: 'room_id', pattern: '!a' }] },
    { rule_id: 'mute-b', actions: [], conditions: [{ kind: 'event_match', key: 'room_id', pattern: '!b' }] },
  ] } } }
  assert.deepEqual([...mutedRoomIds(ad)], ['!b'])
})

test('lists and invites: members survive combining, replies, calendar links', async () => {
  const L = await import('./lists.js')
  const r = {
    a: room('a', 'whatsapp', '@whatsapp_1:x', 'Jonas', [msg('@whatsapp_1:x', now - 10 * H)]),
    b: room('b', 'facebook', '@facebook_2:x', 'Rimas', [msg('@facebook_2:x', now - 10 * H)]),
  }
  let m = buildModel(r, {}, ME, null)
  const ia = m.items.find((i) => i.rooms.includes('a'))
  const ib = m.items.find((i) => i.rooms.includes('b'))
  let { config, id } = L.createList(null, 'Tennis')
  config = L.setMember(config, id, ia, true)
  config = L.setMember(config, id, ib, true)
  assert.deepEqual(L.listsOf(config).map((l) => [l.name, l.members.length]), [['Tennis', 2]])
  assert.equal(L.listsWith(config, ia).length, 1)
  // invite goes out; Jonas answers
  const sentAt = now - 2 * H
  const inv = L.createInvite(config, { listId: id, text: 'Kortas 14:00?', when: '2026-11-25T14:00', sent: [
    { key: ia.key, room: 'a', ts: sentAt }, { key: ib.key, room: 'b', ts: sentAt },
  ] })
  config = inv.config
  r.a.timeline = [...r.a.timeline, msg('@whatsapp_1:x', now - H, 'Taip, žaidžiam!')]
  m = buildModel(r, {}, ME, config)
  const v = L.openInviteFor(config, m.items.find((i) => i.rooms.includes('a')))
  assert.equal(v.id, inv.id)
  const replies = L.repliesTo(v, m, r, ME)
  assert.deepEqual(Object.keys(replies), [ia.key])
  assert.equal(replies[ia.key].content.body, 'Taip, žaidžiam!')
  config = L.setInvite(config, inv.id, { status: 'confirmed', with: ia.key })
  assert.equal(L.openInviteFor(config, ia), null)
  // calendar
  const c = L.calendarLinks({ title: 'Tennis with Jonas', when: '2026-11-25T14:00', minutes: 90, place: 'SEB Arena' })
  assert.match(c.google, /dates=20261125T140000%2F20261125T153000/)
  assert.match(c.google, /ctz=Europe%2FVilnius/)
  assert.match(c.ics, /DTSTART;TZID=Europe\/Vilnius:20261125T140000\r\nDTEND;TZID=Europe\/Vilnius:20261125T153000/)
  assert.equal(L.calendarLinks({ title: 'x', when: '' }), null)
})
