import React, { useEffect, useMemo, useRef, useState } from 'react'
import { go } from '../router.js'
import { previewText, normName, deliveryStatus, setArchived } from '../people.js'
import { PEOPLE_TYPE } from '../matrix.js'
import { TICKS, TICK_TITLE } from './Thread.jsx'
import { Avatar, NetBadge, TopBar, Icon, timeShort } from './common.jsx'
import { networkInfo } from '../networks.js'

export default function Inbox({ ctx, selected }) {
  const { client, model, sugg } = ctx
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [showEmpty, setShowEmpty] = useState(false)

  // SMS chats are under the iM filter, so the filter row stays on one line
  const archivedCount = useMemo(() => model.items.filter((i) => i.archived).length, [model])
  const nets = useMemo(() => [...new Set(model.items.flatMap((i) => i.networks.map((n) => (n === 'sms' ? 'imessage' : n))))], [model])
  const items = useMemo(() => {
    const nq = normName(q)
    return model.items.filter((i) => {
      if (filter === 'archived') { if (!i.archived) return false } else if (i.archived && !nq) return false
      if (filter === 'unread' && !i.unread && !i.mutedUnread && !i.markedUnread) return false
      if (filter === 'groups' && i.kind !== 'group') return false
      if (!['all', 'unread', 'groups', 'archived'].includes(filter) && !i.networks.includes(filter) && !(filter === 'imessage' && i.networks.includes('sms'))) return false
      return !nq || normName(i.name).includes(nq)
    })
  }, [model, q, filter])
  // Bridges create a room for every contact/thread they find, even with no
  // messages (e.g. encrypted Messenger chats without restored history). Keep
  // those out of the way until something is said in them.
  const active = items.filter((i) => i.lastEvent || i.typing || i.unread > 0 || i.mutedUnread > 0)
  const filtered = q || filter !== 'all'
  const home = () => { setQ(''); setFilter('all'); setShowEmpty(false); document.querySelector('.inbox .list')?.scrollTo({ top: 0, behavior: 'smooth' }) }
  const empty = items.filter((i) => !i.lastEvent && !i.typing && !i.unread && !i.mutedUnread) // unread chats always stay visible

  return (
    <div className="page inbox">
      <TopBar
        right={<>
          <button className="icon-btn" onClick={() => go('search')} aria-label="Search messages" title="Search in messages"><Icon name="search" /></button>
          <button className="icon-btn" onClick={() => go('settings')} aria-label="Settings"><Icon name="gear" /></button>
        </>}
      >
        <div className="inbox-head">
          <button className="title-btn" onClick={home} aria-label="Inbox: back to all chats"><h1>Inbox</h1></button>
          <div className="search-wrap">
            <input className="search" placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
            {filtered && <button className="search-clear" onClick={home} aria-label="Clear search and show all chats"><Icon name="close" size={16} /></button>}
          </div>
        </div>
      </TopBar>
      <StatusLine client={client} />
      <div className="inbox-tools">
        <div className="chips">
          {['all', 'unread', ...nets, 'groups'].map((f) => (
            <button key={f} className={`chip ${['all', 'unread', 'groups'].includes(f) ? '' : 'netchip'} ${filter === f ? 'on' : ''}`} onClick={() => setFilter(filter === f && f !== 'all' ? 'all' : f)} aria-pressed={filter === f}>
              {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : f === 'groups' ? 'Groups' : <NetBadge net={f} />}
            </button>
          ))}
        </div>
      </div>
      {sugg.length > 0 && (
        <button className="banner" onClick={() => go('merge')}>
          <Icon name="people" />
          <span><b>{sugg.length} {sugg.length === 1 ? 'person is' : 'people are'} on more than one app.</b> Combine their chats into one thread.</span>
        </button>
      )}
      <ul className="list">
        {filter === 'archived' && (
          <li><button className="archived-row" onClick={() => setFilter('all')}><Icon name="back" size={18} /> <b>Archived</b><span className="muted"> · back to all chats</span></button></li>
        )}
        {filter === 'all' && !q && archivedCount > 0 && (
          <li><button className="archived-row" onClick={() => setFilter('archived')}><Icon name="archive" size={20} /> <span>Archived</span><span className="archived-count">{archivedCount}</span></button></li>
        )}
        {active.map((i) => <Row key={i.key} client={client} i={i} selected={selected} />)}
        {client.synced && empty.length > 0 && (
          <li>
            <button className="empty-toggle" onClick={() => setShowEmpty(!showEmpty)} aria-expanded={showEmpty}>
              {showEmpty ? 'Hide' : 'Show'} {empty.length} {empty.length === 1 ? 'chat' : 'chats'} with no messages yet
            </button>
          </li>
        )}
        {showEmpty && empty.map((i) => <Row key={i.key} client={client} i={i} selected={selected} />)}
        {client.synced && !items.length && (
          <li className="empty">{model.items.length ? 'No matches.' : <>No chats yet. Connect an app in <a href="#/settings">Settings</a>.</>}</li>
        )}
        {!client.synced && (
          <li className="empty loading">
            <div className="spinner" />
            <p>{client.status === 'error' || client.status === 'offline'
              ? 'Still loading your chats. The server is taking a while; retrying…'
              : 'Loading your chats… The first time can take a minute.'}</p>
          </li>
        )}
      </ul>
    </div>
  )
}

function Row({ client, i, selected }) {
  // swipe left (or right-click on the Mac) for Read/Unread and Archive, like WhatsApp
  const [dx, setDx] = useState(0)
  const [open, setOpen] = useState(false)
  const t = useRef(null)
  const W = 252
  const unreadNow = i.unread > 0 || i.mutedUnread > 0 || i.markedUnread
  const close = () => { setOpen(false); setDx(0) }

  // Mac trackpad: a two-finger sideways swipe on a chat reveals the actions (like
  // Telegram) instead of the browser's back/forward gesture. React's wheel handler can't
  // cancel the browser gesture, so this listens directly, non-passively.
  const li = useRef(null)
  const wheel = useRef({ acc: 0, timer: null, base: 0 })
  useEffect(() => {
    const el = li.current
    if (!el) return
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return // vertical: normal scrolling
      e.preventDefault()
      const w = wheel.current
      if (!w.timer) { w.acc = 0; w.base = dxRef.current }
      clearTimeout(w.timer)
      w.acc -= e.deltaX
      const next = Math.min(0, Math.max(-W - 40, w.base + w.acc))
      dxRef.current = next
      setDx(next)
      w.timer = setTimeout(() => {
        w.timer = null
        const o = dxRef.current < -W / 2
        dxRef.current = o ? -W : 0
        setOpen(o)
        setDx(o ? -W : 0)
      }, 140)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const dxRef = useRef(0)
  useEffect(() => { dxRef.current = dx }, [dx])
  const onTouchStart = (e) => { const p = e.touches[0]; t.current = { x: p.clientX, y: p.clientY, base: open ? -W : 0, moving: null } }
  const onTouchMove = (e) => {
    const s = t.current
    if (!s) return
    const p = e.touches[0]
    const mx = p.clientX - s.x
    const my = p.clientY - s.y
    if (s.moving === null) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; s.moving = Math.abs(mx) > Math.abs(my) }
    if (!s.moving) return
    setDx(Math.min(0, Math.max(-W - 40, s.base + mx)))
  }
  const onTouchEnd = () => {
    const s = t.current
    t.current = null
    if (!s?.moving) return
    const o = dx < -W / 2
    setOpen(o)
    setDx(o ? -W : 0)
  }
  async function toggleRead() {
    close()
    if (unreadNow) { for (const id of i.rooms) client.markRead(id) } else client.setMarkedUnread(i.lastRoom || i.rooms[0], true)
  }
  async function toggleMute() {
    close()
    for (const id of i.rooms) client.setMuted(id, !i.muted).catch(() => {})
  }
  async function archive() {
    close()
    await client.setAccountData(PEOPLE_TYPE, setArchived(client.accountData[PEOPLE_TYPE], i, !i.archived)).catch(() => {})
  }
  return (
    <li ref={li} className="swipe" onContextMenu={(e) => { e.preventDefault(); setOpen(true); setDx(-W) }}>
      <div className="swipe-actions" aria-hidden={!open}>
        <button className="swipe-btn mute" onClick={toggleMute}><Icon name={i.muted ? 'bell' : 'muted'} size={20} />{i.muted ? 'Unmute' : 'Mute'}</button>
        <button className="swipe-btn more" onClick={toggleRead}><Icon name={unreadNow ? 'check' : 'dot'} size={20} />{unreadNow ? 'Read' : 'Unread'}</button>
        <button className="swipe-btn archive" onClick={archive}><Icon name="archive" size={20} />{i.archived ? 'Unarchive' : 'Archive'}</button>
      </div>
      <div className="swipe-front" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: t.current ? 'none' : 'transform 0.2s ease-out' }}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onClickCapture={(e) => { if (open) { e.stopPropagation(); e.preventDefault(); close() } }}>
      <button className={`row ${selected === i.key ? 'selected' : ''}`} onClick={() => go('t', i.key)}>
        <Avatar client={client} mxc={i.avatarUrl} name={i.name} />
        <div className="row-main">
          <div className="row-top">
            <span className={`row-name ${i.unread || i.markedUnread ? 'bold' : ''}`}>{i.name}</span>
            <span className="nets" title={i.networks.map((n) => networkInfo(n).name).join(', ')}>
              {i.networks.slice(0, i.networks.length > 2 ? 1 : 2).map((n) => <NetBadge key={n} net={n} />)}
              {i.networks.length > 2 && <span className="net more">+{i.networks.length - 1}</span>}
            </span>
            <span className="row-time">{i.lastEvent ? timeShort(i.lastTs) : ''}</span>
          </div>
          <div className="row-bottom">
            <span className={`row-preview ${i.unread ? 'bold' : ''}`}>
              {i.typing ? <i className="typing-label">typing…</i> : i.lastEvent ? <><ListTicks client={client} i={i} />{previewText(i.lastEvent, i.lastEvent.type === 'm.reaction' ? client.userId : null, client.rooms[i.lastRoom], i.kind === 'group')}</> : <i>No messages yet</i>}
            </span>
            {i.muted && <span className="muted-icon" aria-label="Muted"><Icon name="muted" size={16} /></span>}
            {i.unread > 0 ? <span className="badge">{i.unread}</span>
              : i.mutedUnread > 0 ? <span className="badge quiet" aria-label={`${i.mutedUnread} unread, muted`}>{i.mutedUnread}</span>
                : i.markedUnread ? <span className="badge dot" aria-label="Marked unread" /> : null}
          </div>
        </div>
      </button>
      </div>
    </li>
  )
}

function StatusLine({ client }) {
  if (client.status === 'live' || client.status === 'connecting') return null
  return <div className="status-line">{client.status === 'offline' ? 'Offline. Reconnecting…' : 'Server error. Retrying…'}</div>
}

// ✓ / ✓✓ / blue ✓✓ before the preview when the last message is yours
function ListTicks({ client, i }) {
  const me = client.userId
  if (i.lastEvent?.sender !== me || i.lastEvent.type === 'm.reaction') return null
  const status = deliveryStatus(client.rooms[i.lastRoom], i.lastEvent, me)
  if (!status || status === 'failed') return null
  return <span className={`list-ticks ${status}`} title={TICK_TITLE[status]}>{TICKS[status]} </span>
}
