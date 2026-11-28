// The people he knows (pure, tested in crm.test.js). The `people` service on sky learns
// circles, connection strength, work and facts from his chats every night and publishes them
// (account data fit.simas.inbox.crm → a private JSON file); what he sets in the app lives in
// fit.simas.inbox.crm_edits and always wins. When he changes a suggestion he can say why —
// the nightly run reads those reasons and learns from them.

export const CRM_TYPE = 'fit.simas.inbox.crm'
export const CRM_EDITS_TYPE = 'fit.simas.inbox.crm_edits'
export const DIRECTORY_TYPE = 'fit.simas.inbox.directory'

export const CIRCLES = ['partner', 'family', 'close friend', 'friend', 'colleague', 'former colleague', 'client', 'acquaintance', 'service']
export const CIRCLE_LABEL = {
  partner: 'Partner', family: 'Family', 'close friend': 'Close friend', friend: 'Friend', colleague: 'Colleague',
  'former colleague': 'Former colleague', client: 'Client', acquaintance: 'Acquaintance', service: 'Service',
}
export const CIRCLE_PLURAL = {
  partner: 'Partner', family: 'Family', 'close friend': 'Close friends', friend: 'Friends', colleague: 'Colleagues',
  'former colleague': 'Former colleagues', client: 'Clients', acquaintance: 'Acquaintances', service: 'Services',
}

// "Who is who" for the service: one entry per person in the app (their chats + contact card),
// so the app and the service agree on who is one person.
export function directoryFrom(model) {
  return model.items
    .filter((i) => i.kind === 'person')
    .map((i) => ({ key: i.key, name: i.name, rooms: [...i.rooms].sort(), ...(i.contact?.id ? { href: i.contact.id } : {}) }))
    .sort((a, b) => (a.rooms[0] < b.rooms[0] ? -1 : 1))
}

export function sameDirectory(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || [])
}

// The learned entry for an app person: the one sharing the most chats with them.
export function crmFor(crm, item) {
  if (!crm?.people || !item) return null
  let best = null
  let n = 0
  for (const [cid, p] of Object.entries(crm.people)) {
    const k = p.rooms.filter((r) => item.rooms.includes(r)).length
    if (k > n) { best = { cid, ...p }; n = k }
  }
  return best
}

// What to show: his value where he set one, else what was learned.
export function profileOf(entry, edits) {
  const l = entry?.learned || {}
  const e = (entry && edits?.people?.[entry.cid]) || {}
  const pick = (k, lv) => (e[k] !== undefined && e[k] !== null && e[k] !== '' ? e[k] : lv)
  const removed = new Set(e.tagsRemoved || [])
  const tags = [...new Set([...(l.tags || []).filter((t) => !removed.has(t)), ...(e.tags || [])])].sort()
  const marks = e.facts || {}
  const facts = [
    ...(entry?.facts || []).map((f) => ({ ...f, status: marks[f.id]?.status || f.status })),
    ...(e.notes || []).map((n, i) => ({ id: `mine-${i}`, text: n.text, ts: n.at, status: 'current', mine: true })),
  ].filter((f) => f.status !== 'wrong').sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return {
    circle: pick('circle', l.circle) || null,
    strength: pick('strength', l.strength) ?? null,
    summary: l.summary || '',
    reason: l.reason || '',
    tags,
    met: pick('met', l.met?.how) || '',
    since: pick('since', l.met?.since) || null,
    company: pick('company', l.work?.company) || '',
    role: pick('role', l.work?.role) || '',
    industry: pick('industry', l.work?.industry) || '',
    pastWork: l.past_work || [],
    facts,
    suggested: { circle: l.circle || null, strength: l.strength ?? null },
    mine: { circle: e.circle != null, strength: e.strength != null },
    stats: entry?.stats || {},
    conflicts: (entry?.card?.conflicts || []).filter((c) => (e.keepCard || {})[c.field] !== c.card),
  }
}

// Set one of his values (circle, strength, met, since, company, role, industry), with why.
export function setField(edits, cid, name, field, value, why) {
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  if (value === null || value === undefined || value === '') delete e[field]
  else e[field] = value
  const w = { ...(e.why || {}) }
  if (why && why.trim()) w[field] = why.trim()
  else if (why !== undefined) delete w[field]
  e.why = w
  e.at = { ...(e.at || {}), [field]: Date.now() }
  people[cid] = e
  return { ...(edits || {}), people }
}

export function addTag(edits, cid, name, tag) {
  const t = tag.trim().toLowerCase()
  if (!t) return edits
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  e.tags = [...new Set([...(e.tags || []), t])]
  e.tagsRemoved = (e.tagsRemoved || []).filter((x) => x !== t)
  people[cid] = e
  return { ...(edits || {}), people }
}

export function removeTag(edits, cid, name, tag) {
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  e.tags = (e.tags || []).filter((x) => x !== tag)
  e.tagsRemoved = [...new Set([...(e.tagsRemoved || []), tag])]
  people[cid] = e
  return { ...(edits || {}), people }
}

// A learned fact is wrong / no longer true / true after all — with an optional reason.
export function markFact(edits, cid, name, fact, status, why) {
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  e.facts = { ...(e.facts || {}), [fact.id]: { status, text: fact.text, at: Date.now(), ...(why ? { why } : {}) } }
  people[cid] = e
  return { ...(edits || {}), people }
}

export function addNote(edits, cid, name, text) {
  const t = text.trim()
  if (!t) return edits
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  e.notes = [...(e.notes || []), { text: t, at: Date.now() }]
  people[cid] = e
  return { ...(edits || {}), people }
}

export function removeNote(edits, cid, index) {
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}) }
  e.notes = (e.notes || []).filter((_, i) => i !== index)
  people[cid] = e
  return { ...(edits || {}), people }
}

// "Keep what the card says" for a conflicting field, so it isn't asked again.
export function keepCard(edits, cid, name, field, cardValue) {
  const people = { ...(edits?.people || {}) }
  const e = { ...(people[cid] || {}), name }
  e.keepCard = { ...(e.keepCard || {}), [field]: cardValue }
  people[cid] = e
  return { ...(edits || {}), people }
}

const DAY = 86400_000

// "3 months" since the last message
export function sinceText(ts, now = Date.now()) {
  if (!ts) return 'never'
  const d = Math.floor((now - ts) / DAY)
  if (d < 1) return 'today'
  if (d < 2) return 'yesterday'
  if (d < 14) return `${d} days ago`
  if (d < 60) return `${Math.round(d / 7)} weeks ago`
  if (d < 365) return `${Math.round(d / 30)} months ago`
  const y = Math.round(d / 365)
  return `${y} year${y > 1 ? 's' : ''} ago`
}

// Close people you haven't written to for a while: the closer, the sooner it shows.
export function drifting(profile, now = Date.now()) {
  const s = profile.strength
  const last = profile.stats?.last
  if (s == null || !last || profile.circle === 'service') return false
  const limit = s >= 85 ? 21 : s >= 65 ? 60 : s >= 45 ? 120 : null
  return limit != null && now - last > limit * DAY
}

// The People page: everyone with a profile, by circle, closest first.
export function peopleSections(crm, edits, { q = '', tag = null, circle = null, drift = false } = {}, now = Date.now()) {
  const nq = q.trim().toLowerCase()
  const rows = []
  for (const [cid, p] of Object.entries(crm?.people || {})) {
    const prof = profileOf({ cid, ...p }, edits)
    if (tag && !prof.tags.includes(tag)) continue
    if (circle && prof.circle !== circle) continue
    if (drift && !drifting(prof, now)) continue
    if (nq) {
      const hay = [p.name, prof.company, prof.role, prof.industry, prof.met, prof.summary, ...prof.tags].join(' ').toLowerCase()
      if (!hay.includes(nq)) continue
    }
    rows.push({ cid, name: p.name, rooms: p.rooms, ...prof })
  }
  const by = new Map()
  for (const r of rows) {
    const k = r.circle || 'unsorted'
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(r)
  }
  const order = [...CIRCLES, 'unsorted']
  return [...by.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, list]) => ({ circle: k, people: list.sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1) || (b.stats?.last || 0) - (a.stats?.last || 0)) }))
}

export function allTags(crm, edits) {
  const n = new Map()
  for (const [cid, p] of Object.entries(crm?.people || {})) for (const t of profileOf({ cid, ...p }, edits).tags) n.set(t, (n.get(t) || 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
}
