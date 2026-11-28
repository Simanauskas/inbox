import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { callOptions } from '../calls.js'
import { openExternal } from '../native.js'
import { phoneFromUser } from '../networks.js'
import { loadMedia } from './Media.jsx'
import { go, back } from '../router.js'
import { PEOPLE_TYPE } from '../matrix.js'
import { linkRoom, unlinkRoom, setDefault, renamePerson, mergePeople, normName, setAbout, setPinned } from '../people.js'
import { Avatar, NetBadge, TopBar, Icon, identityOf, timeShort } from './common.jsx'
import { PhoneBookCard, ContactDetails } from './PhoneBook.jsx'
import { ListMembership } from './Lists.jsx'
import GroupPage from './Group.jsx'
import ChatSettings from './ChatSettings.jsx'
import Profile from './Profile.jsx'

export default function Person(props) {
  return props.item.kind === 'group' ? <GroupPage {...props} /> : <Contact {...props} />
}

function Contact({ ctx, item }) {
  const { client, model } = ctx
  const [name, setName] = useState(item.name)
  const [editing, setEditing] = useState(false)
  const [showCard, setShowCard] = useState(false)
  const [calling, setCalling] = useState(false)
  const [mediaCount, setMediaCount] = useState(null)
  useEffect(() => { if (document.activeElement?.getAttribute('aria-label') !== 'Name') setName(item.name) }, [item.name])
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [err, setErr] = useState(null)
  const cfg = client.accountData[PEOPLE_TYPE]
  const save = (c) => client.setAccountData(PEOPLE_TYPE, c).catch((e) => setErr(e.message))
  const first = item.name.split(' ')[0]

  useEffect(() => { for (const id of item.rooms) client.loadMembers(id) }, [item.key])
  useEffect(() => { loadMedia(client, item.rooms, { pages: 1, limit: 100 }).then((xs) => setMediaCount(xs.length)).catch(() => {}) }, [item.key])

  const candidates = useMemo(() => {
    const nq = normName(q)
    return model.items.filter((i) => i.key !== item.key && i.kind === 'person' && (!nq || normName(i.name).includes(nq)))
  }, [model, q, item.key])

  // what to show under the name: their number(s), else how the apps know them
  const numbers = [...new Set(item.rooms.map((id) => model.info[id]?.phone).filter(Boolean))].map(formatPhone)
  const subtitle = numbers[0] || identityOf(client, model.info, item.rooms[0])

  // groups you're both in (by their accounts on the apps, or the same number)
  const common = useMemo(() => {
    const ghosts = new Set(item.rooms.map((id) => model.info[id]?.remote).filter(Boolean))
    const tails = new Set(item.rooms.map((id) => model.info[id]?.phone).filter(Boolean).map((p) => p.slice(-9)))
    return model.items.filter((g) => g.kind === 'group' && g.rooms.some((rid) => Object.entries(client.rooms[rid]?.members || {}).some(([uid, m]) =>
      m.membership === 'join' && (ghosts.has(uid) || (tails.size && tails.has((phoneFromUser(uid) || '').slice(-9)))))))
  }, [model, item.key])

  function rename() {
    const n = name.trim()
    if (n && n !== item.name) save(renamePerson(cfg, item, n))
  }
  function link(other) {
    const { config, personId } = mergePeople(cfg, [item, other], item.name, item.defaultRoom || item.rooms[0])
    save(config)
    setPicking(false)
    go('p', `p:${personId}`)
  }
  function unlink(roomId) {
    if (!item.personId) return
    save(unlinkRoom(cfg, item.personId, roomId))
  }
  const muteAll = () => { for (const id of item.rooms) client.setMuted(id, !item.muted).catch(() => {}) }
  const calls = callOptions(item, model.info)
  const call = (href) => { setCalling(false); openExternal(href).catch(() => {}) }

  return (
    <div className="page person contact-page">
      <TopBar onBack={back} title="Contact info" right={<button className="text-btn" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>} />
      <div className="scroll">
        <div className="hero">
          <Avatar client={client} mxc={item.avatarUrl} name={item.name} size={112} />
          {editing
            ? <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label="Name" autoFocus />
            : <h2 className="hero-name">{item.name}</h2>}
          <div className="hero-sub">{subtitle}</div>
          <div className="hero-nets">{item.networks.map((n) => <NetBadge key={n} net={n} label />)}</div>
        </div>
        {err && <p className="error">{err}</p>}

        <div className="hero-actions">
          <button onClick={() => go('t', item.key)}><Icon name="chat" size={24} /><span>Chat</span></button>
          {calls.length > 0 && <button onClick={() => (calls.length === 1 ? call(calls[0].href) : setCalling(true))}><Icon name="phone" size={24} /><span>Call</span></button>}
          <button onClick={muteAll}><Icon name={item.muted ? 'bell' : 'muted'} size={24} /><span>{item.muted ? 'Unmute' : 'Mute'}</span></button>
        </div>

        <ul className="card-list wa-card">
          <li><button className="setting-row" onClick={() => go('m', item.key)}>
            <Icon name="gallery" size={20} /><span className="grow">Media, links and docs</span>
            <span className="muted">{mediaCount === null ? '' : mediaCount >= 100 ? '100+' : mediaCount}</span><span className="chev">›</span>
          </button></li>
        </ul>

        <ul className="card-list wa-card">
          <li><button className="setting-row" onClick={muteAll}>
            <Icon name="bell" size={20} /><span className="grow">Notifications</span><span className="muted">{item.muted ? 'Muted' : 'On'}</span>
          </button></li>
          <li><button className="setting-row" onClick={() => save(setPinned(cfg, item, !item.pinned))}>
            <Icon name="pinchat" size={20} /><span className="grow">Pin chat</span><span className="muted">{item.pinned ? 'Pinned' : 'Off'}</span>
          </button></li>
        </ul>
        {item.rooms.map((id) => <ChatSettings key={id} client={client} model={model} roomId={id} kind="dm" name={first} part="settings" />)}

        <About client={client} item={item} save={save} cfg={cfg} />

        <Profile ctx={ctx} item={item} />

        <ul className="card-list wa-card">
          <li><button className="setting-row" onClick={() => setShowCard(!showCard)}>
            <Icon name="people" size={20} /><span className="grow">Contact details</span><span className="muted">{item.contact ? 'In your contacts' : 'Not saved'}</span><span className="chev">{showCard ? '⌄' : '›'}</span>
          </button></li>
        </ul>
        {showCard && <><ContactDetails ctx={ctx} item={item} /><PhoneBookCard ctx={ctx} item={item} /></>}

        <h3 className="section">Apps</h3>
        <ul className="card-list wa-card">
          {item.rooms.map((id) => {
            const info = model.info[id]
            const isDefault = item.defaultRoom === id
            return (
              <li key={id} className="channel-row">
                <NetBadge net={info.network} label />
                <div className="grow">
                  <div>{identityOf(client, model.info, id)}</div>
                  <div className="muted small">Last message {timeShort(info.lastTs) || 'never'}</div>
                </div>
                {item.rooms.length > 1 && (
                  <div className="row-actions">
                    <button className={`pill ${isDefault ? 'on' : ''}`} onClick={() => save(setDefault(cfg, item, id))} aria-pressed={isDefault}>{isDefault ? 'Default' : 'Make default'}</button>
                    {item.personId && <button className="text-btn danger" onClick={() => unlink(id)}>Unlink</button>}
                  </div>
                )}
              </li>
            )
          })}
          <li>{picking ? (
            <div className="picker">
              <input className="search" autoFocus placeholder="Search chats to add" value={q} onChange={(e) => setQ(e.target.value)} />
              <ul className="list">
                {candidates.slice(0, 50).map((i) => (
                  <li key={i.key}><button className="row" onClick={() => link(i)}>
                    <Avatar client={client} mxc={i.avatarUrl} name={i.name} size={36} />
                    <div className="row-main"><div className="row-top"><span className="row-name">{i.name}</span></div>
                      <div className="row-bottom"><span className="nets">{i.networks.map((n) => <NetBadge key={n} net={n} label />)}</span></div></div>
                  </button></li>
                ))}
              </ul>
              <button className="text-btn" onClick={() => setPicking(false)}>Cancel</button>
            </div>
          ) : <button className="setting-row accent" onClick={() => setPicking(true)}><Icon name="plus" size={20} /><span className="grow">Add a chat from another app</span></button>}</li>
        </ul>
        {item.rooms.length > 1 && <p className="hint">New messages go to the <b>default</b> app. If they write to you on another app, your reply goes back there.</p>}

        {common.length > 0 && <>
          <h3 className="section">{common.length} {common.length === 1 ? 'group' : 'groups'} in common</h3>
          <ul className="card-list wa-card">
            {common.slice(0, 8).map((g) => (
              <li key={g.key}><button className="member-row" onClick={() => go('t', g.key)}>
                <Avatar client={client} mxc={g.avatarUrl} name={g.name} size={40} />
                <span className="grow"><span className="member-name">{g.name}</span><span className="muted small">{memberNames(client, g)}</span></span>
                <span className="chev">›</span>
              </button></li>
            ))}
          </ul>
        </>}

        <h3 className="section">Lists</h3>
        <ListMembership ctx={ctx} item={item} />

        {item.rooms.map((id) => <ChatSettings key={id} client={client} model={model} roomId={id} kind="dm" name={first} part="danger" />)}
      </div>
      {calling && createPortal(
        <div className="sheet-backdrop" onClick={() => setCalling(false)}>
          <div className="sheet call-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Call ${item.name}`}>
            <h3>Call {item.name}</h3>
            <p className="muted small">Calls open in the app that makes them.</p>
            {calls.map((o) => <button key={o.href} className="wide-btn" onClick={() => call(o.href)}>{o.label}</button>)}
            <button className="text-btn" onClick={() => setCalling(false)}>Cancel</button>
          </div>
        </div>, document.body)}
    </div>
  )
}

// Who this person is to you, in a few words: the reply suggestions use it
// ("partner, warm", "client, polite", "tennis buddy").
function About({ client, item, save, cfg }) {
  const current = (item.personId && cfg?.people?.[item.personId]?.about) || ''
  const [v, setV] = useState(current)
  useEffect(() => { if (document.activeElement?.getAttribute('aria-label') !== 'About') setV(current) }, [current])
  const first = item.name.split(' ')[0]
  const learned = item.rooms.map((id) => client.accountData['fit.simas.inbox.profiles']?.rooms?.[id]).find((p) => p?.note)
  return (
    <>
      <h3 className="section">About {first}</h3>
      {learned && (
        <div className="card learned">
          <p><span className="tag">{learned.category}</span> {learned.note}</p>
          <p className="hint">Learned from your chats{current ? ' — your own note below is used instead' : ''}.</p>
        </div>
      )}
      <div className="card about-card">
        <textarea aria-label="About" rows={2} value={v} maxLength={300} placeholder={learned ? 'Add or correct anything (optional)' : 'e.g. partner · friend from tennis · client, polite'}
          onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== current) save(setAbout(cfg, item, v)) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() } }} enterKeyHint="done" />
        <p className="hint">{learned ? 'If you write here, it replaces the learned note.' : `Helps the reply suggestions answer ${first} the way you would.`}</p>
      </div>
    </>
  )
}

// +370 612 34567 (Lithuanian mobiles), other numbers in groups of 3
export function formatPhone(digits) {
  const d = String(digits).replace(/\D/g, '')
  if (/^370\d{8}$/.test(d)) return `+370 ${d.slice(3, 6)} ${d.slice(6)}`
  return '+' + d.replace(/(\d{3})(?=\d{4,})/g, '$1 ')
}

// "Adomas, Patricija, Ilona…" for a group row
function memberNames(client, g) {
  const names = []
  for (const rid of g.rooms) for (const [uid, m] of Object.entries(client.rooms[rid]?.members || {})) {
    if (uid === client.userId || m.membership !== 'join' || /bot:/.test(uid) || !m.displayname) continue
    names.push(m.displayname.replace(/\s*\((WA|FB|IG|TG)\)$/, '').split(' ')[0])
  }
  return names.slice(0, 5).join(', ') + (names.length > 5 ? '…' : '')
}
