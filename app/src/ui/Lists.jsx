import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { go, back } from '../router.js'
import { PEOPLE_TYPE } from '../matrix.js'
import { chooseChannel, normName, previewText } from '../people.js'
import { isNative, addToAppleCalendar } from '../native.js'
import {
  listsOf, createList, renameList, deleteList, setMember, resolveMember, listsWith,
  createInvite, setInvite, invitesOf, openInviteFor, repliesTo, calendarLinks,
} from '../lists.js'
import { Avatar, NetBadge, TopBar, Icon, timeShort } from './common.jsx'

const cfgOf = (client) => client.accountData[PEOPLE_TYPE]
const save = (client, c) => client.setAccountData(PEOPLE_TYPE, c)

// Where a message to this person goes (same rule as the chat: where they last wrote, else default).
function targetRoom(ctx, item) {
  const { client, model } = ctx
  return chooseChannel(item, client.rooms, client.userId, { windowHours: model.config.replyWindowHours }).roomId
}

async function sendText(ctx, item, text) {
  const roomId = targetRoom(ctx, item)
  await ctx.client.send(roomId, { msgtype: 'm.text', body: text })
  return roomId
}

// ---- all lists ----
export function ListsPage({ ctx }) {
  const { client } = ctx
  const lists = listsOf(cfgOf(client))
  const [name, setName] = useState('')
  async function add() {
    const n = name.trim()
    if (!n) return
    const { config, id } = createList(cfgOf(client), n)
    await save(client, config)
    setName('')
    go('list', id)
  }
  return (
    <div className="page lists">
      <TopBar onBack={back} title="Lists" />
      <div className="scroll pad">
        <p className="hint">Groups of people you message together, e.g. tennis partners. Each person gets your message privately, on their usual app.</p>
        <ul className="card-list">
          {lists.map((l) => (
            <li key={l.id}><button className="row" onClick={() => go('list', l.id)}>
              <span className="list-icon"><Icon name="people" size={20} /></span>
              <span className="row-main"><span className="row-name">{l.name}</span></span>
              <span className="muted">{l.members.length}</span>
            </button></li>
          ))}
          {!lists.length && <li className="empty">No lists yet.</li>}
        </ul>
        <div className="new-list">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New list, e.g. Tennis" onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="primary" disabled={!name.trim()} onClick={add}>Create</button>
        </div>
      </div>
    </div>
  )
}

// ---- one list: pick people, send an invite, follow the replies ----
export function ListPage({ ctx, id }) {
  const { client, model } = ctx
  const cfg = cfgOf(client)
  const list = listsOf(cfg).find((l) => l.id === id)
  const members = useMemo(() => (list?.members || []).map((m) => resolveMember(model, m)).filter(Boolean), [list, model])
  const [picked, setPicked] = useState(() => new Set())
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [text, setText] = useState('')
  const [when, setWhen] = useState('')
  const [minutes, setMinutes] = useState(90)
  const [place, setPlace] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirming, setConfirming] = useState(null) // { invite, item }
  if (!list) return <div className="page"><TopBar onBack={back} title="List" /><p className="empty">This list no longer exists.</p></div>

  const invites = invitesOf(cfg, id).slice(0, 5)
  const candidates = model.items.filter((i) => (i.kind === 'person') && !members.some((m) => m.key === i.key) && (!q || normName(i.name).includes(normName(q)))).slice(0, 30)
  const toggle = (key) => setPicked((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n })
  const allOn = members.length > 0 && members.every((m) => picked.has(m.key))

  async function send() {
    setBusy(true); setErr(null)
    const sent = []
    for (const item of members.filter((m) => picked.has(m.key))) {
      try { const room = await sendText(ctx, item, text.trim()); sent.push({ key: item.key, room, ts: Date.now() }) } catch (e) { setErr(`Couldn't send to ${item.name}: ${e.message}`) }
    }
    if (sent.length) {
      const { config } = createInvite(cfgOf(client), { listId: id, text: text.trim(), when: when || null, minutes, place: place.trim(), sent })
      await save(client, config).catch(() => {})
      setText(''); setPicked(new Set())
    }
    setBusy(false)
  }

  return (
    <div className="page list-page">
      <TopBar onBack={back}>
        <input className="list-title" defaultValue={list.name} aria-label="List name"
          onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== list.name) save(client, renameList(cfgOf(client), id, n)) }} />
      </TopBar>
      <div className="scroll pad">
        {invites.map((v) => <InviteCard key={v.id} ctx={ctx} invite={v} onConfirm={(item) => setConfirming({ invite: v, item })} />)}

        <div className="list-head">
          <h3 className="section">People</h3>
          {members.length > 0 && <button className="text-btn" onClick={() => setPicked(allOn ? new Set() : new Set(members.map((m) => m.key)))}>{allOn ? 'Select none' : 'Select all'}</button>}
        </div>
        <ul className="card-list">
          {members.map((m) => (
            <li key={m.key} className="pick-row">
              <label className="row">
                <input type="checkbox" checked={picked.has(m.key)} onChange={() => toggle(m.key)} />
                <Avatar client={client} mxc={m.avatarUrl} name={m.name} size={36} />
                <span className="row-main"><span className="row-name">{m.name}</span>
                  <span className="nets">{m.networks.slice(0, 2).map((n) => <NetBadge key={n} net={n} />)}</span></span>
              </label>
              <button className="icon-btn" aria-label={`Remove ${m.name} from the list`} onClick={() => save(client, setMember(cfgOf(client), id, m, false))}><Icon name="close" size={16} /></button>
            </li>
          ))}
          {!members.length && <li className="empty">Nobody here yet.</li>}
        </ul>
        {adding ? (
          <div className="card add-people">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person to add" />
            <ul className="plain">
              {candidates.map((c) => (
                <li key={c.key}><button className="row" onClick={() => save(client, setMember(cfgOf(client), id, c, true))}>
                  <Avatar client={client} mxc={c.avatarUrl} name={c.name} size={32} /><span className="row-main"><span className="row-name">{c.name}</span></span><Icon name="plus" size={18} />
                </button></li>
              ))}
            </ul>
            <button className="text-btn" onClick={() => { setAdding(false); setQ('') }}>Done</button>
          </div>
        ) : <button className="wide-btn" onClick={() => setAdding(true)}>+ Add people</button>}

        <h3 className="section">Message {picked.size ? `${picked.size} ${picked.size === 1 ? 'person' : 'people'}` : 'the people you tick'}</h3>
        <div className="card invite-form">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Turiu kortą 14:00, žaidžiam?" />
          <div className="two">
            <label className="field">When (optional)<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
            <label className="field">Length<select value={minutes} onChange={(e) => setMinutes(+e.target.value)}>
              {[60, 90, 120].map((n) => <option key={n} value={n}>{n / 60} h</option>)}
            </select></label>
          </div>
          <label className="field">Place (optional)<input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="e.g. SEB Arena" /></label>
          <p className="muted small">Each person gets it privately on their usual app. When someone says yes, Inbox offers to tell the others and add it to your calendar.</p>
          {err && <p className="error">{err}</p>}
          <button className="primary" disabled={busy || !text.trim() || !picked.size} onClick={send}>{busy ? 'Sending…' : picked.size ? `Send to ${picked.size}` : 'Tick people to send'}</button>
        </div>
        <button className="text-btn danger" onClick={() => { if (confirm(`Delete the list “${list.name}”? The chats stay.`)) { save(client, deleteList(cfgOf(client), id)); back() } }}>Delete list</button>
      </div>
      {confirming && <ConfirmInvite ctx={ctx} invite={confirming.invite} item={confirming.item} onClose={() => setConfirming(null)} />}
    </div>
  )
}

function whenText(v) {
  if (!v.when) return ''
  const d = new Date(v.when)
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

// One sent invite: who it went to, who answered, confirm someone.
function InviteCard({ ctx, invite, onConfirm }) {
  const { client, model } = ctx
  const replies = repliesTo(invite, model, client.rooms, client.userId)
  const status = invite.status === 'confirmed' ? `Confirmed with ${resolveMember(model, invite.sent.find((s) => s.key === invite.with) || {})?.name || 'someone'}`
    : invite.status === 'closed' ? 'Closed' : 'Waiting for answers'
  return (
    <div className={`card invite ${invite.status}`}>
      <div className="invite-top"><b>“{invite.text}”</b><span className="muted small">{whenText(invite)}{invite.place ? ` · ${invite.place}` : ''}</span></div>
      <p className="muted small">{status} · sent {timeShort(invite.at)}</p>
      <ul className="plain">
        {invite.sent.map((s) => {
          const item = resolveMember(model, { key: s.key, room: s.room })
          if (!item) return null
          const r = replies[s.key]
          return (
            <li key={s.key} className="invite-row">
              <button className="link" onClick={() => go('t', item.key)}>{item.name}</button>
              <span className="muted small invite-reply">{r ? `“${previewText(r, client.userId)}”` : 'no answer yet'}</span>
              {invite.status === 'open' && <button className="text-btn" onClick={() => onConfirm(item)}>Confirm</button>}
            </li>
          )
        })}
      </ul>
      {invite.status === 'open' && <button className="text-btn muted" onClick={() => save(client, setInvite(cfgOf(client), invite.id, { status: 'closed' }))}>Close without anyone</button>}
    </div>
  )
}

// Confirm one person → tell the others → add to calendar.
export function ConfirmInvite({ ctx, invite, item, onClose }) {
  const { client, model } = ctx
  const list = listsOf(cfgOf(client)).find((l) => l.id === invite.listId)
  const others = invite.sent.filter((s) => s.key !== item.key && !item.rooms.includes(s.room))
    .map((s) => resolveMember(model, { key: s.key, room: s.room })).filter(Boolean)
  const [step, setStep] = useState('others')
  const [note, setNote] = useState('Ačiū, jau susitariau - kitą kartą! 🎾')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(`${list?.name || 'Meeting'} with ${item.name}`)
  const links = calendarLinks({ title, when: invite.when, minutes: invite.minutes, place: invite.place, details: invite.text })

  async function finishOthers(sendNote) {
    setBusy(true)
    await save(client, setInvite(cfgOf(client), invite.id, { status: 'confirmed', with: item.key, confirmedAt: Date.now() })).catch(() => {})
    if (sendNote) for (const o of others) await sendText(ctx, o, note.trim()).catch(() => {})
    setBusy(false)
    setStep('calendar')
  }

  function openIcs() {
    const url = URL.createObjectURL(new Blob([links.ics], { type: 'text/calendar' }))
    const a = document.createElement('a'); a.href = url; a.download = `${title}.ics`; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet confirm-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Confirm">
        {step === 'others' ? (
          <>
            <h3>Going with {item.name}</h3>
            {others.length ? (
              <>
                <p className="muted small">Tell the other {others.length} you've found someone ({others.map((o) => o.name.split(' ')[0]).join(', ')})?</p>
                <label className="field">Message<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <div className="sugg-actions">
                  <button className="text-btn" disabled={busy} onClick={() => finishOthers(false)}>Don't tell them</button>
                  <button className="primary" disabled={busy || !note.trim()} onClick={() => finishOthers(true)}>{busy ? 'Sending…' : `Send to ${others.length}`}</button>
                </div>
              </>
            ) : (
              <div className="sugg-actions"><button className="primary" disabled={busy} onClick={() => finishOthers(false)}>Confirm</button></div>
            )}
          </>
        ) : (
          <>
            <h3>Add to your calendar?</h3>
            {links ? (
              <>
                <label className="field">Event<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                <p className="muted small">{whenText(invite)}, {invite.minutes / 60} h{invite.place ? ` · ${invite.place}` : ''}</p>
                <button className="wide-btn" onClick={async () => {
                  if (isNative) await addToAppleCalendar({ title, start: links.start, end: links.end, place: invite.place, notes: invite.text }).catch(() => {})
                  else openIcs()
                  onClose()
                }}>Add to Apple Calendar</button>
                <button className="text-btn" onClick={onClose}>Not now</button>
              </>
            ) : (
              <>
                <p className="muted small">This invite had no time set, so there's nothing to add. Next time, fill in “When”.</p>
                <button className="primary" onClick={onClose}>Done</button>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

// In a chat: this person has an open invite from a list.
export function InviteBanner({ ctx, item }) {
  const { client } = ctx
  const invite = openInviteFor(cfgOf(client), item)
  const [open, setOpen] = useState(false)
  if (!invite) return null
  const list = listsOf(cfgOf(client)).find((l) => l.id === invite.listId)
  return (
    <div className="contact-prompt invite-banner">
      <span><b>{list?.name || 'Invite'}</b>: “{invite.text}”{invite.when ? ` · ${whenText(invite)}` : ''}</span>
      <button className="text-btn inline" onClick={() => setOpen(true)}>Confirm {item.name.split(' ')[0]}</button>
      {open && <ConfirmInvite ctx={ctx} invite={invite} item={item} onClose={() => setOpen(false)} />}
    </div>
  )
}

// On a contact's page: which lists they're in.
export function ListMembership({ ctx, item }) {
  const { client } = ctx
  const lists = listsOf(cfgOf(client))
  const inLists = new Set(listsWith(cfgOf(client), item).map((l) => l.id))
  if (!lists.length) return <p className="hint">Make lists (e.g. Tennis) from <button className="text-btn inline" onClick={() => go('lists')}>Lists</button> in the inbox.</p>
  return (
    <ul className="card-list">
      {lists.map((l) => (
        <li key={l.id}><label className="row">
          <input type="checkbox" checked={inLists.has(l.id)} onChange={(e) => save(client, setMember(cfgOf(client), l.id, item, e.target.checked))} />
          <span className="row-main"><span className="row-name">{l.name}</span></span>
        </label></li>
      ))}
    </ul>
  )
}
