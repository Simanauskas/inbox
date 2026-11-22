import React from 'react'
import { PEOPLE_TYPE } from '../matrix.js'
import { normConfig, isDisplayable, clearCustomName } from '../people.js'
import { missingFromCard, vcard } from '../contacts.js'
import { networkInfo } from '../networks.js'
import { Icon } from './common.jsx'

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
    return missing.phones.length || missing.emails.length ? { kind: 'update', name: item.contact.n, ...missing } : null
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

// Hands the card to the iPhone, which shows "Create New Contact" /
// "Add to Existing Contact" — you decide; nothing is changed on its own.
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

const apps = (item) => item.networks.map((n) => networkInfo(n).name).join(', ')

// On the person's page: where the name comes from, and add/update the card.
export function PhoneBookCard({ ctx, item }) {
  const { client, model } = ctx
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
      {s?.kind === 'add' && (
        <button className="wide-btn" onClick={() => openCard(s, apps(item))}><Icon name="people" size={18} /> Add to contacts</button>
      )}
      {s?.kind === 'update' && (
        <>
          <p className="muted small">The apps know {[...s.phones.map((p) => '+' + p), ...s.emails].join(', ')}, which isn't on the card.</p>
          <button className="wide-btn" onClick={() => openCard(s, apps(item))}><Icon name="people" size={18} /> Update contact card</button>
        </>
      )}
      <p className="hint">Your iPhone asks before saving anything.</p>
    </div>
  )
}

// A one-line nudge at the top of a chat with someone you talk to but haven't saved.
export function ContactPrompt({ ctx, item }) {
  const { client, model } = ctx
  const cfg = normConfig(client.accountData[PEOPLE_TYPE])
  const s = cardSuggestion(model, item)
  if (!s || s.kind !== 'add' || (cfg.contactPromptsDismissed || []).includes(item.key) || !talksWith(client, item)) return null
  const dismiss = () => client.setAccountData(PEOPLE_TYPE, { ...cfg, contactPromptsDismissed: [...(cfg.contactPromptsDismissed || []), item.key] })
  return (
    <div className="contact-prompt">
      <span>Save <b>{item.name}</b> to your contacts?</span>
      <button className="text-btn inline" onClick={() => { openCard(s, apps(item)); dismiss() }}>Add</button>
      <button className="icon-btn" onClick={dismiss} aria-label="Don't ask again"><Icon name="close" size={16} /></button>
    </div>
  )
}
