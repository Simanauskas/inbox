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
function requestChange(client, req) {
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
      <p className="hint">{writable(client) ? 'You confirm every change before it’s saved to iCloud.' : 'Your iPhone asks before saving anything.'}</p>
      {open && <ConfirmCard ctx={ctx} item={item} suggestion={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// A one-line nudge at the top of a chat with someone you talk to but haven't saved.
export function ContactPrompt({ ctx, item }) {
  const { client, model } = ctx
  const [open, setOpen] = useState(null)
  const cfg = normConfig(client.accountData[PEOPLE_TYPE])
  const s = cardSuggestion(model, item)
  if (open) return <ConfirmCard ctx={ctx} item={item} suggestion={open} onClose={() => setOpen(null)} />
  if (!s || s.kind !== 'add' || (cfg.contactPromptsDismissed || []).includes(item.key) || !talksWith(client, item)) return null
  const dismiss = () => client.setAccountData(PEOPLE_TYPE, { ...cfg, contactPromptsDismissed: [...(cfg.contactPromptsDismissed || []), item.key] })
  return (
    <div className="contact-prompt">
      <span>Save <b>{item.name}</b> to your contacts?</span>
      <button className="text-btn inline" onClick={() => setOpen(s)}>Add</button>
      <button className="icon-btn" onClick={dismiss} aria-label="Don't ask again"><Icon name="close" size={16} /></button>
    </div>
  )
}
