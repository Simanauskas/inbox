// Group members and what you can do in a group (add, remove, rename, leave).
// Pure functions so they can be unit tested.
import { isBotUser, phoneFromUser, emailFromUser } from './networks.js'
import { contactMatch } from './contacts.js'
import { cleanName, normName } from './people.js'

// What each bridge passes back to the app when you change a group from Inbox.
// iMessage (BlueBubbles) can't add or remove people from a Mac, so its groups are view-only.
const CAPS = {
  whatsapp: { add: true, remove: true, rename: true, topic: true, leave: true, link: '!wa invite-link', addByPhone: true },
  facebook: { add: true, remove: true, rename: true, leave: true },
  instagram: { add: true, remove: true, rename: true, leave: true },
  telegram: { add: true, remove: true, rename: true, topic: true, leave: true },
}
export function groupCaps(network) { return CAPS[network] || {} }

// Matrix power levels: what you're allowed to do in the room. The bridges set them
// from the app, so a WhatsApp group admin gets the rights an admin has there.
export function powerOf(room, uid) {
  const p = room?.power
  if (!p) return 0
  return p.users?.[uid] ?? p.users_default ?? 0
}
export function canDo(room, uid, action) {
  const p = room?.power
  if (!p) return action === 'invite' // nothing known yet: let the bridge decide
  const need = action === 'invite' ? (p.invite ?? 0)
    : action === 'kick' ? (p.kick ?? 50)
    : (p.events?.[action] ?? p.state_default ?? 50)
  return powerOf(room, uid) >= need
}

// "admin" for people the app calls admins (the bridge gives them power), not the bridge bot.
const isAdmin = (room, uid) => powerOf(room, uid) >= 50

// Everyone in the group, as you know them: their Inbox name (your name for them or
// your contacts'), else the contact card, else their app name. You, admins, then A–Z.
export function groupMembers(room, me, { model, contactIdx, bot } = {}) {
  const byRemote = new Map()
  const byContact = new Map()
  for (const it of model?.items || []) {
    if (it.kind !== 'person') continue
    for (const id of it.rooms) {
      const r = model.info[id]?.remote
      if (r && !byRemote.has(r)) byRemote.set(r, it)
    }
    if (it.contact?.id && !byContact.has(it.contact.id)) byContact.set(it.contact.id, it)
  }
  const list = []
  for (const [uid, m] of Object.entries(room?.members || {})) {
    if (m.membership !== 'join' && m.membership !== 'invite') continue
    if (uid === bot || uid === room.bridge?.bridgebot || (isBotUser(uid) && uid !== me)) continue
    const appName = cleanName(m.displayname || '') || null
    const phone = phoneFromUser(uid)
    const email = emailFromUser(uid)
    const contact = uid === me ? null : contactMatch(contactIdx, { phone, email, names: [appName] })?.contact || null
    const item = uid === me ? null : byRemote.get(uid) || (contact?.id && byContact.get(contact.id)) || null
    const name = uid === me ? 'You' : item?.name || contact?.n || appName || (phone ? '+' + phone : uid.slice(1).split(':')[0])
    list.push({ uid, name, appName, phone, email, contact, item, me: uid === me, admin: isAdmin(room, uid), invited: m.membership === 'invite', avatarUrl: m.avatarUrl || null })
  }
  list.sort((a, b) => (b.me - a.me) || (b.admin - a.admin) || (!!b.contact - !!a.contact) || a.name.localeCompare(b.name))
  return list
}

// Ghost user ids on this bridge look like @whatsapp_37061234567:server: the prefix and
// server come from a member of the group already on it.
export function ghostFor(room, me, phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 8) return null
  for (const uid of Object.keys(room?.members || {})) {
    if (uid === me || isBotUser(uid)) continue
    const m = /^@([a-z]+)_[^:]*:(.+)$/i.exec(uid)
    if (m) return `@${m[1]}_${digits}:${m[2]}`
  }
  return null
}

// People you can add: they have a 1:1 chat with you on the same app, and aren't in the group.
export function addable(room, me, model, query = '') {
  const net = model.info[room.id]?.network
  const inGroup = new Set(Object.entries(room.members || {}).filter(([, m]) => m.membership === 'join' || m.membership === 'invite').map(([u]) => u))
  const server = (uid) => uid.split(':').slice(1).join(':')
  const prefix = (uid) => uid.slice(1).split('_')[0]
  const sample = Object.keys(room.members || {}).find((u) => u !== me && !isBotUser(u) && u.includes('_'))
  const nq = normName(query)
  const out = []
  for (const it of model.items) {
    if (it.kind !== 'person') continue
    const rid = it.rooms.find((id) => model.info[id]?.network === net && model.info[id]?.kind === 'dm' && model.info[id]?.remote)
    if (!rid) continue
    const uid = model.info[rid].remote
    if (inGroup.has(uid)) continue
    if (sample && (server(uid) !== server(sample) || prefix(uid) !== prefix(sample))) continue
    if (nq && !normName(it.name).includes(nq)) continue
    out.push({ uid, item: it })
  }
  return out
}
