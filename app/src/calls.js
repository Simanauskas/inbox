// Calls can't go through the bridges (WhatsApp, Messenger and FaceTime calls are
// end-to-end and no bridge carries them), so a call button hands off to the app
// that can: WhatsApp, FaceTime / the phone, or Messenger. Pure, unit-tested.
import { normalizePhone } from './contacts.js'

const fbId = (uid) => /^@facebook_(\d+):/.exec(uid || '')?.[1] || null

// [{ label, href }] for a person (or a single chat), best first, no duplicates.
export function callOptions(item, info) {
  const phones = []
  const emails = []
  const out = []
  const add = (label, href) => { if (href && !out.some((o) => o.href === href)) out.push({ label, href }) }
  for (const id of item.rooms) {
    const i = info[id]
    if (!i) continue
    if (i.phone) phones.push(i.phone)
    if (i.email) emails.push(i.email)
  }
  for (const p of item.contact?.p || []) { const n = normalizePhone(p); if (n) phones.push(n) }
  const uniq = [...new Set(phones)]
  const nets = new Set(item.rooms.map((id) => info[id]?.network))
  const main = uniq[0] // their number: from the chats, else the contact card
  if (nets.has('whatsapp') && main) add('WhatsApp', `https://wa.me/${main}`)
  if (main) {
    add('FaceTime audio', `facetime-audio://+${main}`)
    add('FaceTime video', `facetime://+${main}`)
  } else {
    for (const e of [...new Set(emails)].slice(0, 1)) add('FaceTime', `facetime://${e}`)
  }
  for (const id of item.rooms) {
    const i = info[id]
    if (i?.network === 'facebook' && fbId(i.remote)) add('Messenger', `fb-messenger://user-thread/${fbId(i.remote)}`)
  }
  if (main) add(`Phone · +${main}`, `tel:+${main}`)
  return out
}
