// Lists of people (e.g. "Tennis") and invites sent to a list: one private message to
// each chosen person, tracked until someone says yes; then "tell the others" and
// "add to calendar". Stored in the people account data (config.lists / config.invites)
// so the phone and the Mac agree. Pure functions, unit-tested.
import { normConfig, isDisplayable } from './people.js'

const newId = () => Math.random().toString(36).slice(2, 10)

export function listsOf(rawConfig) {
  const c = normConfig(rawConfig)
  return Object.entries(c.lists || {}).map(([id, l]) => ({ id, name: l.name, members: l.members || [] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function createList(rawConfig, name) {
  const c = normConfig(rawConfig)
  const id = newId()
  c.lists = { ...(c.lists || {}), [id]: { name: name.trim(), members: [] } }
  return { config: c, id }
}

export function renameList(rawConfig, id, name) {
  const c = normConfig(rawConfig)
  if (c.lists?.[id]) c.lists = { ...c.lists, [id]: { ...c.lists[id], name: name.trim() } }
  return c
}

export function deleteList(rawConfig, id) {
  const c = normConfig(rawConfig)
  const { [id]: _, ...rest } = c.lists || {}
  c.lists = rest
  return c
}

// A member is remembered by the chat's key plus one of its rooms, so it is found again
// after chats are combined into a person (the key changes, the room doesn't).
export const memberOf = (item) => ({ key: item.key, room: item.rooms[0] })

export function setMember(rawConfig, listId, item, on) {
  const c = normConfig(rawConfig)
  const l = c.lists?.[listId]
  if (!l) return c
  const rest = (l.members || []).filter((m) => !(m.key === item.key || item.rooms.includes(m.room)))
  c.lists = { ...c.lists, [listId]: { ...l, members: on ? [...rest, memberOf(item)] : rest } }
  return c
}

// the inbox item a stored member is now, if the chat still exists
export function resolveMember(model, m) {
  return model.items.find((i) => i.key === m.key) || model.items.find((i) => i.rooms.includes(m.room)) || null
}

export function listsWith(rawConfig, item) {
  return listsOf(rawConfig).filter((l) => l.members.some((m) => m.key === item.key || item.rooms.includes(m.room)))
}

// --- invites ---

export function createInvite(rawConfig, { listId, text, when = null, minutes = 90, place = '', sent }) {
  const c = normConfig(rawConfig)
  const id = newId()
  c.invites = { ...(c.invites || {}), [id]: { listId, text, when, minutes, place, sent, at: Date.now(), status: 'open' } }
  return { config: c, id }
}

export function setInvite(rawConfig, id, patch) {
  const c = normConfig(rawConfig)
  if (c.invites?.[id]) c.invites = { ...c.invites, [id]: { ...c.invites[id], ...patch } }
  return c
}

export function invitesOf(rawConfig, listId = null) {
  const c = normConfig(rawConfig)
  return Object.entries(c.invites || {}).map(([id, v]) => ({ id, ...v }))
    .filter((v) => !listId || v.listId === listId)
    .sort((a, b) => b.at - a.at)
}

// The open invite this person was sent (newest first), if any.
export function openInviteFor(rawConfig, item) {
  return invitesOf(rawConfig).find((v) => v.status === 'open' && v.sent.some((s) => s.key === item.key || item.rooms.includes(s.room))) || null
}

// What each invited person said after the invite went out: the first message from them.
export function repliesTo(invite, model, rooms, me) {
  const out = {}
  for (const s of invite.sent) {
    const item = resolveMember(model, { key: s.key, room: s.room })
    if (!item) continue
    let first = null
    for (const id of item.rooms) {
      for (const e of rooms[id]?.timeline || []) {
        if (e.sender !== me && isDisplayable(e) && e.origin_server_ts > s.ts && (!first || e.origin_server_ts < first.origin_server_ts)) first = e
      }
    }
    if (first) out[s.key] = first
  }
  return out
}

// --- calendar ---

// "2026-11-25T14:00" (a local time from <input type="datetime-local">) → event links:
// Google Calendar opens with the event filled in; the .ics works with Apple Calendar.
export function calendarLinks({ title, when, minutes = 90, place = '', details = '', tz = 'Europe/Vilnius' }) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(when || '')
  if (!m) return null
  const pad = (n) => String(n).padStart(2, '0')
  const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  const end = new Date(start.getTime() + minutes * 60_000)
  const local = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${local(start)}/${local(end)}`, ctz: tz })
  if (place) q.set('location', place)
  if (details) q.set('details', details)
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inbox//EN', 'BEGIN:VEVENT',
    `UID:${local(start)}-${Math.random().toString(36).slice(2, 8)}@inbox`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;TZID=${tz}:${local(start)}`, `DTEND;TZID=${tz}:${local(end)}`,
    `SUMMARY:${esc(title)}`, ...(place ? [`LOCATION:${esc(place)}`] : []), ...(details ? [`DESCRIPTION:${esc(details)}`] : []),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n'
  return { google: `https://calendar.google.com/calendar/render?${q}`, ics, start, end }
}
