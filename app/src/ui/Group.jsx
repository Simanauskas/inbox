import React, { useEffect, useMemo, useState } from 'react'
import { go, back } from '../router.js'
import { networkInfo } from '../networks.js'
import { normName } from '../people.js'
import { groupCaps, groupMembers, canDo, powerOf, addable, ghostFor } from '../group.js'
import { Avatar, NetBadge, TopBar, Icon } from './common.jsx'
import { ConfirmCard } from './PhoneBook.jsx'

// A group's page, like WhatsApp's "Group info": name, description, who's in it,
// and (where the app's bridge allows) adding and removing people, the invite link, leaving.
export default function GroupPage({ ctx, item }) {
  const { client, model } = ctx
  const roomId = item.rooms[0]
  const room = client.rooms[roomId]
  const net = model.info[roomId]?.network
  const app = networkInfo(net).name
  const caps = groupCaps(net)
  const me = client.userId
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null) // member sheet
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => { client.loadMembers(roomId); client.loadGroupState(roomId) }, [roomId])

  const members = useMemo(() => groupMembers(room, me, { model, contactIdx: client.contactIdx }), [ctx.version, roomId])
  const shown = q ? members.filter((m) => normName(m.name).includes(normName(q)) || (m.phone || '').includes(q.replace(/\D/g, '') || '-')) : members
  const canAdd = caps.add && canDo(room, me, 'invite')
  const canRename = caps.rename && canDo(room, me, 'm.room.name')
  const canTopic = caps.topic && canDo(room, me, 'm.room.topic')

  async function leave() {
    if (!confirm(`Leave “${item.name}”? You leave the group on ${app} too.`)) return
    try { await client.leave(roomId); go('inbox') } catch (e) { setMsg({ err: e.message }) }
  }

  return (
    <div className="page person group-page">
      <TopBar onBack={back} title="Group info" right={<button className="text-btn" onClick={() => go('t', item.key)}>Chat</button>} />
      <div className="scroll">
        <div className="person-head">
          <Avatar client={client} mxc={item.avatarUrl} name={item.name} size={80} />
          {canRename ? <EditableText value={room?.name || item.name} label="Group name" className="name-input" onSave={(name) => client.setRoomState(roomId, 'm.room.name', { name })} />
            : <h2>{item.name}</h2>}
          <p className="muted small"><NetBadge net={net} label /> · Group · {members.length} {members.length === 1 ? 'member' : 'members'}</p>
        </div>

        {(room?.topic || canTopic) && (
          <div className="card group-topic">
            {canTopic ? <EditableText value={room?.topic || ''} label="Description" multiline placeholder="Add a group description" onSave={(topic) => client.setRoomState(roomId, 'm.room.topic', { topic })} />
              : <p className="pre">{room.topic}</p>}
          </div>
        )}

        {msg && <p className={msg.err ? 'error' : 'hint'}>{msg.err || msg.ok}</p>}

        <h3 className="section">{members.length} members</h3>
        {members.length > 8 && <input className="search" placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} />}
        <ul className="card-list members">
          {canAdd && !q && (
            <li><button className="member-row" onClick={() => setAdding(true)}>
              <span className="member-icon"><Icon name="plus" size={20} /></span><span className="grow">Add members</span>
            </button></li>
          )}
          {caps.link && !q && <InviteLink client={client} room={room} />}
          {shown.map((m) => (
            <li key={m.uid}>
              <button className="member-row" onClick={() => !m.me && setOpen(m)} disabled={m.me}>
                <Avatar client={client} mxc={m.item?.avatarUrl || m.avatarUrl} name={m.name} size={40} />
                <span className="grow">
                  <span className="member-name">{m.name}</span>
                  <span className="muted small">{memberSub(m)}</span>
                </span>
                {m.admin && <span className="tag">Admin</span>}
                {m.invited && <span className="tag muted">Invited</span>}
              </button>
            </li>
          ))}
        </ul>
        {!caps.add && <p className="hint">{app} groups can't be changed from Inbox. Add or remove people in the {app} app.</p>}

        {caps.leave && <button className="wide-btn danger" onClick={leave}>Leave group</button>}
      </div>
      {open && <MemberSheet ctx={ctx} room={room} group={item} m={open} caps={caps} onClose={() => setOpen(null)} onDone={setMsg} />}
      {adding && <AddMembers ctx={ctx} room={room} caps={caps} app={app} onClose={() => setAdding(false)} onDone={setMsg} />}
    </div>
  )
}

function memberSub(m) {
  if (m.me) return ''
  const bits = []
  if (m.phone) bits.push('+' + m.phone)
  if (m.appName && m.appName !== m.name) bits.push('~' + m.appName)
  if (!m.contact && !m.item) bits.push('not in your contacts')
  return bits.join(' · ')
}

function EditableText({ value, label, onSave, multiline, placeholder, className }) {
  const [v, setV] = useState(value)
  const [err, setErr] = useState(null)
  useEffect(() => { if (document.activeElement?.getAttribute('aria-label') !== label) setV(value) }, [value])
  const save = () => { const t = v.trim(); if (t !== (value || '').trim() && (t || multiline)) onSave(t).catch((e) => { setErr(e.message); setV(value) }) }
  const props = { value: v, onChange: (e) => setV(e.target.value), onBlur: save, 'aria-label': label, placeholder, className }
  return <>{multiline ? <textarea rows={1} {...props} className="topic-input" /> : <input {...props} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />}{err && <p className="error small">{err}</p>}</>
}

// Tap a member: message them, see or save their contact, remove them.
function MemberSheet({ ctx, room, group, m, caps, onClose, onDone }) {
  const { client, model } = ctx
  const me = client.userId
  const net = model.info[room.id]?.network
  const app = networkInfo(net).name
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [card, setCard] = useState(null)
  const first = m.name.split(' ')[0]
  const canRemove = caps.remove && canDo(room, me, 'kick') && powerOf(room, me) > powerOf(room, m.uid)

  async function message() {
    if (m.item) { go('t', m.item.key); return }
    setBusy(`Opening a chat with ${first} on ${app}…`)
    setErr(null)
    try {
      let r
      if (net === 'imessage' || net === 'sms') {
        // the iMessage bridge starts chats from its own chat: "pm +370…"
        const conn = model.connections.find((c) => ['imessage', 'sms'].includes(model.info[c.rooms[0]]?.network))
        const target = m.phone ? '+' + m.phone : m.email
        if (!conn || !target) throw new Error('No iMessage connection to start the chat from.')
        await client.send(conn.rooms[0], { msgtype: 'm.text', body: `pm ${target}` })
        r = await client.waitFor((x) => x.id !== room.id && x.members[m.uid]?.membership === 'join' && Object.values(x.members).filter((y) => y.membership === 'join').length <= 3)
      } else {
        // inviting their account into a new chat makes the bridge turn it into your 1:1 chat on the app
        const rid = await client.createDM(m.uid)
        r = await client.waitFor((x) => x.id === rid, 10000)
      }
      if (!r) throw new Error(`${app} is still setting up the chat. It shows up in your inbox in a moment.`)
      go('t', `r:${r.id}`)
    } catch (e) { setErr(e.message); setBusy(null) }
  }

  async function remove() {
    if (!confirm(`Remove ${m.name} from “${group.name}”? They're removed on ${app} too.`)) return
    setBusy('Removing…')
    try { await client.kick(room.id, m.uid); onDone({ ok: `${m.name} removed from the group.` }); onClose() } catch (e) { setErr(e.message); setBusy(null) }
  }

  const fakeItem = { key: `g:${m.uid}`, networks: [net], rooms: [] }
  if (card) return <ConfirmCard ctx={ctx} item={fakeItem} suggestion={card} onClose={() => { setCard(null); onClose() }} />

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet member-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={m.name}>
        <div className="member-sheet-head">
          <Avatar client={client} mxc={m.item?.avatarUrl || m.avatarUrl} name={m.name} size={56} />
          <div><h3>{m.name}</h3><p className="muted small">{memberSub(m) || app}</p></div>
        </div>
        {busy && <p className="muted"><span className="spinner small" /> {busy}</p>}
        {err && <p className="error">{err}</p>}
        <div className="sheet-actions">
          <button className="wide-btn" onClick={message} disabled={!!busy}><Icon name="chat" size={18} /> Message {first}</button>
          {m.item && <button className="wide-btn" onClick={() => go('p', m.item.key)}><Icon name="people" size={18} /> View contact</button>}
          {!m.contact && (m.phone || m.email || !m.item) && (
            <button className="wide-btn" onClick={() => setCard({ kind: 'add', name: m.appName || m.name, phones: m.phone ? [m.phone] : [], emails: m.email ? [m.email] : [] })}>
              <Icon name="people" size={18} /> Add to contacts
            </button>
          )}
          {canRemove && <button className="wide-btn danger" onClick={remove} disabled={!!busy}>Remove from group</button>}
          <button className="text-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Pick people you already chat with on this app, or (WhatsApp) type a number.
function AddMembers({ ctx, room, caps, app, onClose, onDone }) {
  const { client, model } = ctx
  const me = client.userId
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState({}) // uid -> name
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const list = useMemo(() => addable(room, me, model, q), [q, ctx.version])
  const typedGhost = caps.addByPhone && phone.trim() ? ghostFor(room, me, phone.replace(/^\+/, '').replace(/^8(?=6\d{7}$)/, '370')) : null
  const chosen = Object.entries(picked)
  if (typedGhost && !picked[typedGhost]) chosen.push([typedGhost, phone.trim()])

  async function add() {
    setBusy(true); setErr(null)
    const failed = []
    for (const [uid, name] of chosen) {
      try { await client.invite(room.id, uid) } catch (e) { failed.push(`${name}: ${e.message}`) }
    }
    setBusy(false)
    if (failed.length) { setErr(failed.join('\n')); return }
    onDone({ ok: `Added ${chosen.map(([, n]) => n).join(', ')}. ${app} confirms in a moment — if someone's privacy settings don't allow it, they won't appear.` })
    onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet add-members" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add members">
        <h3>Add members</h3>
        <input className="search" autoFocus placeholder={`Search people on ${app}`} value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="list pick-list">
          {list.slice(0, 60).map(({ uid, item }) => (
            <li key={uid}>
              <label className="member-row">
                <input type="checkbox" checked={!!picked[uid]} onChange={(e) => { const p = { ...picked }; if (e.target.checked) p[uid] = item.name; else delete p[uid]; setPicked(p) }} />
                <Avatar client={client} mxc={item.avatarUrl} name={item.name} size={32} />
                <span className="grow">{item.name}</span>
              </label>
            </li>
          ))}
          {!list.length && <li className="muted small">Nobody {q ? 'matches' : 'to add'} — only people you chat with on {app} are listed.</li>}
        </ul>
        {caps.addByPhone && (
          <label className="field">Or a phone number
            <input type="tel" inputMode="tel" placeholder="+370 612 34567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        )}
        {err && <p className="error pre">{err}</p>}
        <div className="sugg-actions">
          <button className="text-btn" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!chosen.length || busy} onClick={add}>{busy ? 'Adding…' : `Add${chosen.length ? ` ${chosen.length}` : ''}`}</button>
        </div>
      </div>
    </div>
  )
}

// WhatsApp's "Invite via link": the bridge fetches it with its invite-link command.
function InviteLink({ client, room }) {
  const [state, setState] = useState(null) // null | 'loading' | { link } | { err }
  async function get() {
    setState('loading')
    const since = Date.now() - 2000
    const bot = room.bridge?.bridgebot
    const found = () => [...room.timeline].reverse().find((e) => e.origin_server_ts >= since && e.content?.msgtype === 'm.notice' && (!bot || e.sender === bot) && /chat\.whatsapp\.com\/|Failed to get invite link/.test(e.content.body || ''))
    const wait = new Promise((resolve) => {
      const un = client.subscribe(() => { const e = found(); if (e) { un(); clearTimeout(t); resolve(e) } })
      const t = setTimeout(() => { un(); resolve(null) }, 20000)
    })
    try { await client.send(room.id, { msgtype: 'm.text', body: '!wa invite-link' }) } catch (e) { setState({ err: e.message }); return }
    const e = await wait
    const link = e && /https:\/\/chat\.whatsapp\.com\/\S+/.exec(e.content.body)?.[0]
    setState(link ? { link } : { err: e ? e.content.body : 'WhatsApp didn’t answer. Only group admins can get the link.' })
  }
  const share = (link) => (navigator.share ? navigator.share({ url: link }).catch(() => {}) : navigator.clipboard?.writeText(link))
  return (
    <li>
      <button className="member-row" onClick={() => state?.link ? share(state.link) : get()} disabled={state === 'loading'}>
        <span className="member-icon"><Icon name="link" size={20} /></span>
        <span className="grow">
          {state?.link ? <><span className="member-name">{state.link}</span><span className="muted small">Tap to {navigator.share ? 'share' : 'copy'}</span></>
            : state === 'loading' ? 'Getting the invite link…'
            : 'Invite via link'}
          {state?.err && <span className="error small">{state.err}</span>}
        </span>
      </button>
    </li>
  )
}
