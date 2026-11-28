import React, { useState } from 'react'
import { PEOPLE_TYPE } from '../matrix.js'
import { normConfig, isDisplayable, clearCustomName } from '../people.js'
import { missingFromCard, vcard, normalizePhone } from '../contacts.js'
import { networkInfo } from '../networks.js'
import { Icon } from './common.jsx'

export const CONTACTS_TYPE = 'fit.simas.inbox.contacts'
export const REQUESTS_TYPE = 'fit.simas.inbox.contact_requests'
export const RESULTS_TYPE = 'fit.simas.inbox.contact_results'

// What the apps know about this person (phone numbers, emails).
function foundDetails(model, item) {
  const phones = []
  const emails = []
  for (const id of item.rooms) {
    const i = model.info[id]
    if (i?.phone) phones.push(i.phone)
    if (i?.email) emails.push(i.email)
  }
  return { phones, emails }
}

// 'add' (not in your contacts) | 'update' (the apps know a number/email the
// card doesn't have) | null — plus the details to put on the card.
export function cardSuggestion(model, item) {
  if (item.kind !== 'person') return null
  const found = foundDetails(model, item)
  if (item.contact) {
    const missing = missingFromCard(item.contact, found)
    return missing.phones.length || missing.emails.length ? { kind: 'update', name: item.contact.n, href: item.contact.id, ...missing } : null
  }
  return { kind: 'add', name: item.name, phones: [...new Set(found.phones)], emails: [...new Set(found.emails)] }
}

// Only nudge for people you actually talk with (not couriers or one-off sales):
// both of you have written at least 3 messages.
export function talksWith(client, item) {
  let mine = 0
  let theirs = 0
  for (const id of item.rooms) {
    for (const e of client.rooms[id]?.timeline || []) {
      if (!isDisplayable(e)) continue
      if (e.sender === client.userId) mine++
      else theirs++
    }
  }
  return mine >= 3 && theirs >= 3
}

// Without iCloud access: hand the card to the iPhone, which shows
// "Create New Contact" / "Add to Existing Contact".
export function openCard(s, appNames) {
  const v = vcard({ name: s.name, phones: s.phones, emails: s.emails, note: appNames ? `Messages via ${appNames} (Inbox)` : undefined })
  const url = URL.createObjectURL(new Blob([v], { type: 'text/vcard' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${s.name.replace(/[\\/:*?"<>|]/g, '')}.vcf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// With iCloud access the server writes the change: ask it via account data,
// and read the outcome from the results it writes back.
export function requestChange(client, req) {
  const results = client.accountData[RESULTS_TYPE]?.results || {}
  const pending = (client.accountData[REQUESTS_TYPE]?.requests || []).filter((r) => !results[r.rid])
  const rid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return client.setAccountData(REQUESTS_TYPE, { requests: [...pending, { ...req, rid, at: Date.now() }] }).then(() => rid)
}

const apps = (item) => item.networks.map((n) => networkInfo(n).name).join(', ')
const writable = (client) => !!client.accountData[CONTACTS_TYPE]?.writable

// The confirmation: exactly what will be saved, each detail can be left out,
// nothing happens until "Save to iCloud".
export function ConfirmCard({ ctx, item, suggestion, onClose }) {
  const { client } = ctx
  const [name, setName] = useState(suggestion.name)
  const all = [...suggestion.phones.map((p) => ({ kind: 'phone', value: p, label: '+' + p })), ...suggestion.emails.map((e) => ({ kind: 'email', value: e, label: e }))]
  const [keep, setKeep] = useState(() => Object.fromEntries(all.map((d) => [d.value, true])))
  const [typed, setTyped] = useState('')
  const [rid, setRid] = useState(null)
  const [err, setErr] = useState(null)
  const result = rid ? client.accountData[RESULTS_TYPE]?.results?.[rid] : null
  const chosen = all.filter((d) => keep[d.value])
  // a number you type (their usual one), so WhatsApp, iMessage and SMS chats match it too
  const typedPhone = typed.trim() ? normalizePhone(typed) : null
  const badPhone = !!typed.trim() && !typedPhone
  const phones = [...new Set([...chosen.filter((d) => d.kind === 'phone').map((d) => d.value), ...(typedPhone ? [typedPhone] : [])])]
  const emails = chosen.filter((d) => d.kind === 'email').map((d) => d.value)
  const canSave = name.trim() && !badPhone && (suggestion.kind === 'add' || phones.length || emails.length)

  async function save() {
    setErr(null)
    if (!writable(client)) { openCard({ name: name.trim(), phones, emails }, apps(item)); onClose(); return }
    try {
      setRid(await requestChange(client, suggestion.kind === 'add'
        ? { kind: 'create', name: name.trim(), phones, emails }
        : { kind: 'update', href: suggestion.href, phones, emails }))
      onClose() // sky saves it within ~20 s; the contact page shows how it went
    } catch (e) { setErr(e.message) }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet confirm-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Contact card">
        <h3>{suggestion.kind === 'add' ? 'New contact' : `Update ${suggestion.name}`}</h3>
        {suggestion.kind === 'add'
          ? <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} disabled={!!rid} /></label>
          : <p className="muted small">Adds these to the card. Nothing else on it changes.</p>}
        {all.length > 0 && (
          <ul className="details">
            {all.map((d) => (
              <li key={d.value}>
                <label className="radio">
                  <input type="checkbox" checked={!!keep[d.value]} disabled={!!rid} onChange={(e) => setKeep({ ...keep, [d.value]: e.target.checked })} />
                  <span>{d.kind === 'phone' ? '📞' : '✉️'} {d.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <label className="field">Phone number{suggestion.kind === 'add' ? ' (optional)' : ''}
          <input type="tel" inputMode="tel" placeholder="+370 612 34567" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={!!rid} />
        </label>
        {badPhone && <p className="error small">That doesn't look like a phone number.</p>}
        {err && <p className="error">{err}</p>}
        {rid && !result && <p className="muted"><span className="spinner small" /> Saving to iCloud…</p>}
        {result?.ok && <p>✓ Saved to iCloud ({result.message}). It shows up on your iPhone in a moment.</p>}
        {result && !result.ok && <p className="error">iCloud didn’t accept it: {result.message}</p>}
        <div className="sugg-actions">
          <button className="text-btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!rid && <button className="primary" disabled={!canSave} onClick={save}>{writable(client) ? 'Save to iCloud' : 'Open in Contacts'}</button>}
        </div>
      </div>
    </div>
  )
}

// On the person's page: where the name comes from, and add/update the card.
export function PhoneBookCard({ ctx, item }) {
  const { client, model } = ctx
  // the sheet keeps what it opened with: the suggestion goes away once saved
  const [open, setOpen] = useState(null)
  const s = cardSuggestion(model, item)
  const cfg = client.accountData[PEOPLE_TYPE]
  return (
    <div className="card phonebook">
      {item.nameSource === 'user' && (
        <p>You named them <b>{item.name}</b>.{' '}
          <button className="text-btn inline" onClick={() => client.setAccountData(PEOPLE_TYPE, clearCustomName(cfg, item))}>
            Use the name from {item.contact ? 'your contacts' : 'the app'}
          </button>
        </p>
      )}
      {item.nameSource !== 'user' && item.contact && <p>Named as in <b>your contacts</b>.</p>}
      {item.nameSource !== 'user' && !item.contact && <p className="muted">Not in your contacts, so the name comes from {apps(item)}.</p>}
      {s?.kind === 'add' && <button className="wide-btn" onClick={() => setOpen(s)}><Icon name="people" size={18} /> Add to contacts</button>}
      {!s && item.contact && !(item.contact.p || []).length && (
        <button className="wide-btn" onClick={() => setOpen({ kind: 'update', name: item.contact.n, href: item.contact.id, phones: [], emails: [] })}>
          <Icon name="people" size={18} /> Add their phone number
        </button>
      )}
      {s?.kind === 'update' && (
        <>
          <p className="muted small">The apps know {[...s.phones.map((p) => '+' + p), ...s.emails].join(', ')}, which isn't on the card.</p>
          <button className="wide-btn" onClick={() => setOpen(s)}><Icon name="people" size={18} /> Update contact card</button>
        </>
      )}
      <SaveStatus client={client} />
      <p className="hint">{writable(client) ? 'You confirm every change before it’s saved to iCloud.' : 'Your iPhone asks before saving anything.'}</p>
      {open && <ConfirmCard ctx={ctx} item={item} suggestion={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// Changes waiting for sky to save to iCloud, and the latest one that iCloud refused.
function SaveStatus({ client }) {
  const results = client.accountData[RESULTS_TYPE]?.results || {}
  const reqs = client.accountData[REQUESTS_TYPE]?.requests || []
  const pending = reqs.filter((r) => !results[r.rid] && Date.now() - (r.at || 0) < 10 * 60_000)
  const failed = reqs.map((r) => results[r.rid]).filter((x) => x && !x.ok).slice(-1)[0]
  const recent = reqs.slice(-1)[0]
  if (pending.length) return <p className="muted small"><span className="spinner small" /> Saving to iCloud…</p>
  if (failed && recent && results[recent.rid] === failed) return <p className="error small">iCloud didn’t accept the last change: {failed.message}</p>
  return null
}

// A one-line nudge at the top of a chat with someone you talk to but haven't saved.
export function ContactPrompt({ ctx, item }) {
  const { client, model } = ctx
  const [open, setOpen] = useState(null)
  const cfg = normConfig(client.accountData[PEOPLE_TYPE])
  const s = cardSuggestion(model, item)
  if (open) return <ConfirmCard ctx={ctx} item={item} suggestion={open} onClose={() => setOpen(null)} />
  if (!s || s.kind !== 'add' || (cfg.contactPromptsDismissed || []).includes(item.key) || !talksWith(client, item)) return null
  // already being saved (sky picks it up within ~20 s)
  const results = client.accountData[RESULTS_TYPE]?.results || {}
  if ((client.accountData[REQUESTS_TYPE]?.requests || []).some((r) => r.kind === 'create' && Date.now() - (r.at || 0) < 10 * 60_000 && (!results[r.rid] || results[r.rid].ok))) return null
  const dismiss = () => client.setAccountData(PEOPLE_TYPE, { ...cfg, contactPromptsDismissed: [...(cfg.contactPromptsDismissed || []), item.key] })
  return (
    <div className="contact-prompt">
      <span>Save <b>{item.name}</b> to your contacts?</span>
      <button className="text-btn inline" onClick={() => setOpen(s)}>Add</button>
      <button className="icon-btn" onClick={dismiss} aria-label="Don't ask again"><Icon name="close" size={16} /></button>
    </div>
  )
}

// ---- The contact card itself: everything on it, editable, saved to iCloud ----

const PHONE_LABELS = ['mobile', 'iPhone', 'home', 'work', 'main', 'other']
const EMAIL_LABELS = ['home', 'work', 'other']

function formatBday(v) {
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})$/.exec(v || '')
  if (!m) return v
  const d = new Date(Date.UTC(m[1] === '--' ? 2000 : +m[1], +m[2] - 1, +m[3]))
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', ...(m[1] === '--' ? {} : { year: 'numeric' }), timeZone: 'UTC' })
}
const isoBday = (v) => { const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v || ''); return m ? `${m[1]}-${m[2]}-${m[3]}` : '' }

function Row({ label, children }) {
  return <li className="detail-row"><span className="detail-label">{label || ' '}</span><span className="detail-value">{children}</span></li>
}

export function ContactDetails({ ctx, item }) {
  const { client } = ctx
  const [editing, setEditing] = useState(false)
  const c = item.contact
  if (!c) return null
  const d = c.d || { ph: (c.p || []).map((p) => ['', p]), em: (c.e || []).map((e) => ['', e]) }
  const rows = [
    ...(d.ph || []).map(([l, v], i) => <Row key={'p' + i} label={l || 'phone'}><a href={`tel:${v.replace(/[^\d+]/g, '')}`}>{v}</a></Row>),
    ...(d.em || []).map(([l, v], i) => <Row key={'e' + i} label={l || 'email'}><a href={`mailto:${v}`}>{v}</a></Row>),
    ...(d.org || d.title ? [<Row key="org" label="company">{[d.title, d.org].filter(Boolean).join(', ')}</Row>] : []),
    ...(d.bday ? [<Row key="bday" label="birthday">{formatBday(d.bday)}</Row>] : []),
    ...(d.adr || []).map(([l, v], i) => <Row key={'a' + i} label={l || 'address'}>{v}</Row>),
    ...(d.url || []).map(([l, v], i) => <Row key={'u' + i} label={l || 'website'}><a href={/^https?:/.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer">{v}</a></Row>),
    ...(d.note ? [<Row key="note" label="note"><span className="pre">{d.note}</span></Row>] : []),
  ]
  return (
    <div className="card contact-details">
      <div className="details-head">
        <span className="muted small">iCloud card</span>
        {writable(client) && c.d && <button className="text-btn" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {rows.length ? <ul className="detail-list">{rows}</ul> : <p className="muted small">Nothing else on the card yet.</p>}
      {editing && <EditCard ctx={ctx} contact={c} onClose={() => setEditing(false)} />}
    </div>
  )
}

function ListEditor({ title, rows, setRows, labels, type, placeholder, disabled }) {
  const id = `labels-${title}`
  const set = (i, j, v) => setRows(rows.map((r, k) => (k === i ? (j === 0 ? [v, r[1]] : [r[0], v]) : r)))
  return (
    <fieldset className="list-editor" disabled={disabled}>
      <legend>{title}</legend>
      <datalist id={id}>{labels.map((l) => <option key={l} value={l} />)}</datalist>
      {rows.map((r, i) => (
        <div className="list-row" key={i}>
          <input className="label-input" list={id} value={r[0]} placeholder="label" onChange={(e) => set(i, 0, e.target.value)} />
          <input type={type} inputMode={type === 'tel' ? 'tel' : 'email'} value={r[1]} placeholder={placeholder} onChange={(e) => set(i, 1, e.target.value)} />
          <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setRows(rows.filter((_, k) => k !== i))}><Icon name="close" size={16} /></button>
        </div>
      ))}
      <button type="button" className="text-btn" onClick={() => setRows([...rows, [labels[0], '']])}>+ Add {title === 'Phones' ? 'phone' : 'email'}</button>
    </fieldset>
  )
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Edit the card; only the fields you changed are sent, and sky changes only those on iCloud.
export function EditCard({ ctx, contact, onClose }) {
  const { client } = ctx
  const d = contact.d || {}
  const start = {
    first: d.first || '', last: d.last || '', org: d.org || '', title: d.title || '',
    bday: isoBday(d.bday), note: d.note || '', ph: (d.ph || []).map((x) => [...x]), em: (d.em || []).map((x) => [...x]),
  }
  const [f, setF] = useState(start)
  const [rid, setRid] = useState(null)
  const [err, setErr] = useState(null)
  const result = rid ? client.accountData[RESULTS_TYPE]?.results?.[rid] : null
  const field = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }), disabled: !!rid })

  const clean = (rows) => rows.map(([l, v]) => [l.trim(), v.trim()]).filter(([, v]) => v)
  const badPhone = clean(f.ph).find(([, v]) => !normalizePhone(v))
  const badEmail = clean(f.em).find(([, v]) => !/^[^@\s]+@[^@\s]+$/.test(v))
  const changes = {}
  if (f.first.trim() !== start.first || f.last.trim() !== start.last) { changes.first = f.first.trim(); changes.last = f.last.trim() }
  for (const k of ['org', 'title', 'note']) if (f[k].trim() !== start[k]) changes[k] = f[k].trim()
  if (f.bday !== start.bday) changes.bday = f.bday
  if (!same(clean(f.ph), start.ph)) changes.ph = clean(f.ph)
  if (!same(clean(f.em), start.em)) changes.em = clean(f.em)
  const n = Object.keys(changes).length
  const canSave = n && (f.first.trim() || f.last.trim()) && !badPhone && !badEmail

  async function save() {
    setErr(null)
    try { setRid(await requestChange(client, { kind: 'edit', href: contact.id, changes })) } catch (e) { setErr(e.message) }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet confirm-card edit-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit contact">
        <h3>Edit contact</h3>
        <div className="two">
          <label className="field">First name<input {...field('first')} /></label>
          <label className="field">Last name<input {...field('last')} /></label>
        </div>
        <ListEditor title="Phones" rows={f.ph} setRows={(ph) => setF({ ...f, ph })} labels={PHONE_LABELS} type="tel" placeholder="+370 612 34567" disabled={!!rid} />
        {badPhone && <p className="error small">“{badPhone[1]}” doesn’t look like a phone number.</p>}
        <ListEditor title="Emails" rows={f.em} setRows={(em) => setF({ ...f, em })} labels={EMAIL_LABELS} type="email" placeholder="name@example.com" disabled={!!rid} />
        {badEmail && <p className="error small">“{badEmail[1]}” doesn’t look like an email.</p>}
        <div className="two">
          <label className="field">Company<input {...field('org')} /></label>
          <label className="field">Job title<input {...field('title')} /></label>
        </div>
        <label className="field">Birthday<input type="date" {...field('bday')} /></label>
        <label className="field">Note<textarea rows={3} {...field('note')} /></label>
        <p className="muted small">Saved to the card in iCloud; the photo, addresses and anything else on it stay as they are.</p>
        {err && <p className="error">{err}</p>}
        {rid && !result && <p className="muted"><span className="spinner small" /> Saving to iCloud…</p>}
        {result?.ok && <p>✓ Saved to iCloud. It shows up here and on your iPhone in a moment.</p>}
        {result && !result.ok && <p className="error">iCloud didn’t accept it: {result.message}</p>}
        <div className="sugg-actions">
          <button className="text-btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!rid && <button className="primary" disabled={!canSave} onClick={save}>Save to iCloud</button>}
        </div>
      </div>
    </div>
  )
}
