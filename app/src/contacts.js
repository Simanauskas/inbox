// Your phone book (iCloud contacts, read by the server from iCloud) — used to name people the way you saved them and to spot the same
// person on different apps. Pure functions, unit-tested.
import { normName } from './people.js'

// Digits only, international form without "+". Lithuanian numbers saved the old
// way ("8 612 34567", "861234567") or without a country code ("612 34567") are
// read as +370.
export function normalizePhone(raw) {
  if (!raw) return null
  let d = String(raw).replace(/[^\d+]/g, '')
  if (d.startsWith('+')) return d.slice(1)
  if (d.startsWith('00')) return d.slice(2)
  if (/^8[3-9]\d{7}$/.test(d)) return '370' + d.slice(1)
  if (/^6\d{7}$/.test(d)) return '370' + d
  return d.length >= 7 ? d : null
}

const tail = (digits) => digits.slice(-9)

// Name words in a fixed order, so "Bakutis Tadas" (surname first, as many
// cards are saved) and "Tadas Bakutis" (how Messenger shows him) are the same.
export function nameKey(s) {
  return normName(s).split(' ').filter(Boolean).sort().join(' ')
}

export function indexContacts(data) {
  const list = (data?.contacts || []).filter((c) => c.n)
  const byTail = new Map()
  const byEmail = new Map()
  const nameCount = new Map()
  for (const c of list) {
    for (const p of c.p || []) { const n = normalizePhone(p); if (n && n.length >= 8) byTail.set(tail(n), c) }
    for (const e of c.e || []) byEmail.set(e.toLowerCase(), c)
    const k = nameKey(c.n)
    nameCount.set(k, (nameCount.get(k) || 0) + 1)
  }
  // a name only identifies someone if it's a full name and nobody else has it
  const byName = new Map()
  const fullNames = []
  for (const c of list) {
    const k = nameKey(c.n)
    if (k.includes(' ') && nameCount.get(k) === 1) { byName.set(k, c); fullNames.push([new Set(k.split(' ')), c]) }
  }
  return { list, byTail, byEmail, byName, fullNames, size: list.length }
}

// The card whose name words are all in this name ("Tomas Petras Rupšys" on an app,
// "Rupšys Tomas" on the card), if exactly one card fits.
function bySubset(idx, name) {
  const words = new Set(nameKey(name).split(' ').filter(Boolean))
  if (words.size < 2) return null
  const fits = (idx.fullNames || []).filter(([w]) => [...w].every((x) => words.has(x)))
  return fits.length === 1 ? fits[0][1] : null
}

// The contact card for a chat, if there is one: by phone number (WhatsApp,
// iMessage, SMS), email (iMessage), or for apps without numbers (Messenger,
// Instagram, Telegram) by a full name that only one card has, in any word order.
export function contactFor(idx, { phone, email, names = [] }) {
  if (!idx?.size) return null
  if (phone) { const c = idx.byTail.get(tail(phone)); if (c) return c }
  if (email) { const c = idx.byEmail.get(email.toLowerCase()); if (c) return c }
  for (const n of names) { const c = n && idx.byName.get(nameKey(n)); if (c) return c }
  for (const n of names) { const c = n && bySubset(idx, n); if (c) return c }
  return null
}

// What the apps know that the contact card doesn't (for "Update contact card").
export function missingFromCard(contact, found) {
  const havePhones = new Set((contact?.p || []).map((p) => { const n = normalizePhone(p); return n && tail(n) }))
  const haveEmails = new Set((contact?.e || []).map((e) => e.toLowerCase()))
  return {
    phones: [...new Set(found.phones)].filter((p) => !havePhones.has(tail(p))),
    emails: [...new Set(found.emails.map((e) => e.toLowerCase()))].filter((e) => !haveEmails.has(e)),
  }
}

const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')

// A vCard the iPhone opens as "Create New Contact / Add to Existing Contact".
export function vcard({ name, phones = [], emails = [], note }) {
  const parts = name.trim().split(/\s+/)
  const last = parts.length > 1 ? parts.pop() : ''
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(name)}`, `N:${esc(last)};${esc(parts.join(' '))};;;`]
  for (const p of phones) lines.push(`TEL;TYPE=CELL:+${p}`)
  for (const e of emails) lines.push(`EMAIL;TYPE=INTERNET:${esc(e)}`)
  if (note) lines.push(`NOTE:${esc(note)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n') + '\r\n'
}
