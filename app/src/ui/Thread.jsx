import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isNative, pickPhotos, openExternal, donateConversation } from '../native.js'
import { takeSharedDraft, onSharedDraft } from '../shareDraft.js'
import { callOptions } from '../calls.js'
import { go, back } from '../router.js'
import { chooseChannel, mergedTimeline, stripReply, previewText, cleanName, deliveryStatus, normConfig, canEdit, canDelete, pollOf, tallyPoll, POLL_START } from '../people.js'
import { markdownToHtml, mentionQuery } from '../format.js'
import Rich, { hasRichFormatting } from './Rich.jsx'
import { networkInfo } from '../networks.js'
import { Avatar, NetBadge, TopBar, Icon, useMedia, ago, identityOf } from './common.jsx'
import { ContactPrompt } from './PhoneBook.jsx'
import { InviteBanner, PlanBanner } from './Lists.jsx'
import { EMOJI_GRID, quickReactions, splitEmojis, reactionsFor, allowedReaction } from '../emoji.js'
import { PEOPLE_TYPE } from '../matrix.js'
import { isLooking, onLookingChange } from '../looking.js'

// manual channel picks survive navigating away and back (per person, this session)
const overrides = new Map()

export default function Thread({ ctx, item }) {
  const { client, model } = ctx
  const rooms = client.rooms
  const me = client.userId
  const multi = item.rooms.length > 1
  const isGroup = item.kind === 'group'
  const { entries, hasMore } = mergedTimeline(item, rooms)
  // drawn underneath another page (phone back stack): don't act as the open chat
  const live = !ctx.background
  useWhatsAppViewing(client, model, item, live)
  const scroller = useRef(null)
  const atBottom = useRef(true)
  const [loading, setLoading] = useState(false)
  const [replyTo, setReplyTo] = useState(null) // { ev, roomId }
  const [editing, setEditing] = useState(null) // { ev, roomId }: your message being edited
  const [active, setActive] = useState(null) // event id with open action bar
  const [picker, setPicker] = useState(null) // { ev, roomId } for the "+" emoji panel
  const [forwarding, setForwarding] = useState(null) // the message being forwarded
  const [notice, setNotice] = useState(null)
  const quick = quickReactions(normConfig(client.accountData[PEOPLE_TYPE]))
  const [, tick] = useState(0)

  const override = overrides.get(item.key)
  const choice = chooseChannel(item, rooms, me, { override, windowHours: model.config.replyWindowHours })
  const target = replyTo?.roomId || choice.roomId

  async function loadOlder() {
    if (loading) return
    const pending = item.rooms.map((id) => rooms[id]).filter((r) => r && !r.reachedStart)
    if (!pending.length) return
    // the room whose loaded history ends most recently is the one holding the view back
    const oldest = (r) => r.timeline.find((e) => !e.local)?.origin_server_ts ?? Infinity
    pending.sort((a, b) => oldest(b) - oldest(a))
    setLoading(true)
    const el = scroller.current
    const before = el ? el.scrollHeight - el.scrollTop : 0
    try { await client.paginate(pending[0].id) } catch {}
    setLoading(false)
    requestAnimationFrame(() => { if (el && !atBottom.current) el.scrollTop = el.scrollHeight - before })
  }

  // fill the screen with history on open
  useEffect(() => {
    if (entries.length < 25 && hasMore && !loading) loadOlder()
  })

  // stick to the bottom as messages arrive
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })
  // ...and when the chat area changes size (the keyboard opening or closing, a photo
  // loading): keep the newest message in view if you were at the bottom
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const stick = () => { if (atBottom.current) el.scrollTop = el.scrollHeight }
    const ro = new ResizeObserver(stick)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  // Read receipts only while you're actually looking: the window in front AND you've
  // touched the mouse/keyboard in the last minute. On the Mac the Inbox window stays
  // "visible" behind other apps and while you're out, and marking things read then
  // cleared your counts and made you miss messages.
  const roomsKey = item.rooms.join('|')
  useEffect(() => {
    const look = () => {
      const on = live && isLooking()
      // this device shows nothing for the chat you're reading; other devices still notify
      client.quietRooms(on ? item.rooms : [])
      if (on) for (const id of item.rooms) if (rooms[id]) client.markRead(id)
    }
    look()
    const off = onLookingChange(look)
    return () => { off(); client.quietRooms([]) }
  }, [roomsKey, live])
  useEffect(() => {
    if (live && isLooking()) for (const id of item.rooms) if (rooms[id]) client.markRead(id)
  }, [ctx.version, item.key])

  useEffect(() => { for (const id of item.rooms) client.loadFeatures(id) }, [roomsKey])
  // your newest message you can still edit (↑ in an empty box on the Mac)
  const lastEditable = () => { for (let i = entries.length - 1; i >= 0; i--) { const en = entries[i]; if (en.ev.sender === me && !en.ev.local) return canEdit(rooms[en.roomId], en.ev, me) ? en : null } return null }

  // refresh "2h ago" labels
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(t) }, [])

  function onScroll(e) {
    const el = e.currentTarget
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 200 && hasMore) loadOlder()
  }

  // "Seen" goes under my newest message that they've read (like Messenger)
  let lastSeenId = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const en = entries[i]
    if (en.ev.sender !== me) continue
    if (deliveryStatus(rooms[en.roomId], en.ev, me) === 'seen') { lastSeenId = en.ev.event_id; break }
  }

  const typing = item.rooms.flatMap((id) => (rooms[id]?.typing || []).filter((u) => u !== me).map((u) => ({ u, id })))
  const why = replyTo ? 'replying to that message'
    : choice.reason === 'recent' ? `${item.name.split(' ')[0]} wrote here ${ago(choice.ts)}`
    : choice.reason === 'default' ? 'default app'
    : choice.reason === 'picked' ? 'you picked this'
    : choice.reason === 'last' ? 'last used' : ''
  const pick = (roomId) => { overrides.set(item.key, { roomId, ts: Date.now() }); setReplyTo(null); tick((x) => x + 1) }
  // two chats on the same app (e.g. two WhatsApp numbers) get a number each
  // One badge per app, even when someone has two chats on it (e.g. Messenger's older chat and
  // the newer encrypted one, or WhatsApp on two numbers). The badge sends to the chat you're
  // on, else the one with the newest message (item.rooms is newest first).
  const targetNet = model.info[target]?.network
  const nets = []
  for (const id of item.rooms) {
    const n = model.info[id]?.network
    if (!nets.some((x) => x.n === n)) nets.push({ n, id: n === targetNet ? target : id })
  }
  const multiNet = nets.length > 1

  return (
    <div className="page thread">
      <TopBar onBack={back} right={<CallButton item={item} model={model} />}>
        <div className="thread-head">
          <button className="thread-avatar" onClick={() => go('p', item.key)} aria-label={`About ${item.name}`}>
            <Avatar client={client} mxc={item.avatarUrl} name={item.name} size={36} />
          </button>
          <div className="thread-title">
            <button className="thread-name" onClick={() => go('p', item.key)}><h1>{item.name}</h1></button>
            {/* the apps this person is on: the highlighted one is where your message goes; tap another to switch */}
            <div className="thread-sub" role={multiNet ? 'radiogroup' : undefined} aria-label={multiNet ? 'Send on' : undefined}>
              {nets.map(({ n, id }) => {
                const name = networkInfo(n).name
                const on = n === targetNet
                return multiNet ? (
                  <button key={n} role="radio" aria-checked={on} className={`ch-pick ${on ? 'on' : ''}`} style={{ '--net': networkInfo(n).color }}
                    onClick={() => pick(id)} aria-label={`${name}${on ? `, sending here (${why})` : ''}`} title={`${name} · ${identityOf(client, model.info, id)}${on ? ` · sending here (${why})` : ''}`}>
                    <NetBadge net={n} />
                  </button>
                ) : <NetBadge key={n} net={n} label />
              })}
              {typing.length > 0 && <i className="typing-label">typing…</i>}
            </div>
          </div>
        </div>
      </TopBar>
      <ContactPrompt ctx={ctx} item={item} />
      <InviteBanner ctx={ctx} item={item} />
      <PlanBanner ctx={ctx} item={item} />
      <RequestBanner ctx={ctx} item={item} />
      {notice && <div className="contact-prompt"><span>{notice}</span><button className="icon-btn" onClick={() => setNotice(null)} aria-label="Close"><Icon name="close" size={16} /></button></div>}
      <div className="timeline" ref={scroller} onScroll={onScroll} onClick={() => setActive(null)}>
        {hasMore ? <div className="older">{loading ? <div className="spinner small" /> : <button onClick={loadOlder}>Load older messages</button>}</div>
          : <div className="older muted">Start of your history</div>}
        {entries.map((en, idx) => {
          const prev = entries[idx - 1]
          const next = entries[idx + 1]
          const day = !prev || new Date(prev.ev.origin_server_ts).toDateString() !== new Date(en.ev.origin_server_ts).toDateString()
          const switched = multi && (!prev || prev.roomId !== en.roomId || day)
          const first = day || switched || !prev || prev.ev.sender !== en.ev.sender || en.ev.origin_server_ts - prev.ev.origin_server_ts > 300000
          const last = !next || next.ev.sender !== en.ev.sender || next.roomId !== en.roomId || next.ev.origin_server_ts - en.ev.origin_server_ts > 300000
          return (
            <React.Fragment key={en.ev.event_id}>
              {day && <div className="day"><span>{dayLabel(en.ev.origin_server_ts)}</span></div>}
              <Bubble
                ctx={ctx} en={en} mine={en.ev.sender === me} first={first} last={last} showNet={switched} multi={multi}
                showSender={isGroup && first && en.ev.sender !== me}
                status={en.ev.sender === me ? deliveryStatus(rooms[en.roomId], en.ev, me) : null}
                seenHere={en.ev.event_id === lastSeenId}
                open={active === en.ev.event_id}
                onOpen={() => setActive(en.ev.event_id)}
                onReply={() => { setReplyTo(en); setEditing(null); setActive(null) }}
                onEdit={canEdit(rooms[en.roomId], en.ev, me) ? () => { setEditing(en); setReplyTo(null); setActive(null) } : null}
                quick={quick}
                onReact={(k) => { client.react(en.roomId, en.ev.event_id, k).catch(() => {}); setActive(null) }}
                onMore={() => { setPicker(en); setActive(null) }}
                onForward={() => { setForwarding(en); setActive(null) }}
                onDelete={canDelete(rooms[en.roomId], en.ev, me) ? () => {
                  setActive(null)
                  if (confirm(`Delete this message for everyone on ${networkInfo(model.info[en.roomId]?.network).name}?`)) client.redact(en.roomId, en.ev.event_id).catch((e) => setNotice(`Couldn't delete: ${e.message}`))
                } : null}
                onVote={(ids) => client.vote(en.roomId, en.ev.event_id, ids).catch((e) => setNotice(`Couldn't vote: ${e.message}`))}
              />
            </React.Fragment>
          )
        })}
        {typing.length > 0 && <div className="typing"><span /><span /><span /></div>}
      </div>
      {picker && (
        <EmojiSheet allowed={rooms[picker.roomId]?.features?.allowed_reactions} onClose={() => setPicker(null)}
          onPick={(k) => {
            const ok = allowedReaction(rooms[picker.roomId]?.features, k)
            if (ok) client.react(picker.roomId, picker.ev.event_id, ok).catch(() => {})
            else setNotice(`${networkInfo(model.info[picker.roomId]?.network).name} doesn't allow ${k} as a reaction.`)
            setPicker(null)
          }} />
      )}
      {forwarding && <ForwardSheet ctx={ctx} en={forwarding} onClose={() => setForwarding(null)} onDone={(name) => { setForwarding(null); setNotice(`Forwarded to ${name}`) }} />}
      <Composer
        ctx={ctx} item={item} target={target} replyTo={replyTo}
        editing={editing} onEdit={(en) => { setEditing(en); setReplyTo(null) }} onCancelEdit={() => setEditing(null)} lastEditable={lastEditable}
        onClearReply={() => setReplyTo(null)}
        onSent={() => { setReplyTo(null); atBottom.current = true }}
      />
    </div>
  )
}

function dayLabel(ts) {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export const TICKS = { sending: '◌', sent: '✓', delivered: '✓✓', seen: '✓✓' }
export const TICK_TITLE = { sending: 'Sending', sent: 'Sent to your server', delivered: 'Delivered', seen: 'Seen' }

// Press and hold (or right-click) a message for reactions and actions, like
// every other chat app. A plain tap does nothing (tapping a photo opens it).
function useLongPress(onLong, ms = 420) {
  const timer = useRef(null)
  const start = useRef(null)
  const fired = useRef(false)
  const clear = () => { clearTimeout(timer.current); timer.current = null }
  return {
    onPointerDown: (e) => {
      if (e.button && e.button !== 0) return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(() => { fired.current = true; navigator.vibrate?.(8); onLong() }, ms)
    },
    onPointerMove: (e) => {
      if (timer.current && start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e) => { e.preventDefault(); clear(); fired.current = true; onLong() },
    // after a long press, swallow the click that follows (so a photo doesn't open)
    onClickCapture: (e) => { if (fired.current) { e.stopPropagation(); e.preventDefault(); fired.current = false } },
  }
}

function Bubble({ ctx, en, mine, first, last, showNet, multi, showSender, status, seenHere, open, onOpen, onReply, onEdit, onReact, onMore, onForward, onDelete, onVote, quick }) {
  const { client, model } = ctx
  const press = useLongPress(onOpen)
  const box = useRef(null)
  // the bar floats above the message (below it if the message is at the top of the screen)
  const [below, setBelow] = useState(false)
  useLayoutEffect(() => { if (open && box.current) setBelow(box.current.getBoundingClientRect().top < 150) }, [open])
  const { ev, roomId, reactions } = en
  const room = client.rooms[roomId]
  const net = model.info[roomId]?.network
  const c = ev.content || {}
  const notice = c.msgtype === 'm.notice' && !mine
  const bar = reactionsFor(room?.features, quick)
  const deleted = ev.redacted || ev.unsigned?.redacted_because
  const replyId = c['m.relates_to']?.['m.in_reply_to']?.event_id
  const quoted = replyId ? room?.byId[replyId] : null
  const time = new Date(ev.origin_server_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  return (
    <div ref={box} className={`msg ${mine ? 'out' : 'in'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${notice ? 'notice' : ''} ${open ? 'open' : ''}`} style={{ '--net': networkInfo(net).color }}>
      {showNet && <div className="msg-net"><NetBadge net={net} label /></div>}
      {showSender && <div className="msg-sender">{cleanName(room?.members[ev.sender]?.displayname || ev.sender)}</div>}
      <div className={`bubble ${open ? 'pressed' : ''}`} {...press}>
        {replyId && (
          <div className="quote">{quoted ? previewText(quoted, client.userId).replace(/^You: /, '') : 'Replying to an earlier message'}</div>
        )}
        {ev.type === POLL_START ? <Poll client={client} room={room} ev={ev} votes={en.votes} onVote={onVote} /> : <MessageBody client={client} ev={ev} members={room?.members} room={room} />}
        <span className="meta">
          {ev.edited && 'edited · '}
          {time}
          {multi && <i className="dot" title={networkInfo(net).name} />}
          {status && status !== 'failed' && <span className={`ticks ${status}`} title={TICK_TITLE[status]}>{TICKS[status]}</span>}
        </span>
      </div>
      {ev.status === 'failed' && (
        <button className="failed" onClick={() => client.retry(roomId, ev.event_id).catch(() => {})}>Not sent. Tap to retry</button>
      )}
      {reactions && (
        <div className="reactions">
          {Object.values(reactions).map((r) => <span key={r.key} className={r.senders.includes(client.userId) ? 'mine' : ''}>{r.key}{r.count > 1 && ` ${r.count}`}</span>)}
        </div>
      )}
      {open && !ev.local && (
        <div className={`actions ${below ? 'below' : 'above'}`} onClick={(e) => e.stopPropagation()} role="toolbar" aria-label="Message actions">
          {!deleted && (
            <div className="act-row">
              {bar.map((k) => <button key={k} onClick={() => onReact(k)}>{k}</button>)}
              <button className="more" onClick={onMore} aria-label="More emojis">＋</button>
            </div>
          )}
          <div className="act-row tools">
            <button onClick={onReply} aria-label="Reply" title="Reply"><Icon name="reply" size={22} /><span>Reply</span></button>
            {onEdit && <button onClick={onEdit} aria-label="Edit" title="Edit"><Icon name="edit" size={22} /><span>Edit</span></button>}
            {!deleted && <button onClick={onForward} aria-label="Forward" title="Forward"><Icon name="forward" size={22} /><span>Forward</span></button>}
            {c.body && !deleted && <button onClick={() => navigator.clipboard?.writeText(stripReply(c.body))} aria-label="Copy" title="Copy"><Icon name="copy" size={22} /><span>Copy</span></button>}
            {onDelete && !deleted && <button className="danger" onClick={onDelete} aria-label="Delete for everyone" title="Delete for everyone"><Icon name="trash" size={22} /><span>Delete</span></button>}
          </div>
        </div>
      )}
    </div>
  )
}

function MessageBody({ client, ev, members, room }) {
  const c = ev.content || {}
  if (ev.redacted || ev.unsigned?.redacted_because) return <span className="muted"><i>Message deleted</i></span>
  if (ev.type === 'm.sticker') return <Img client={client} c={c} sticker />
  switch (c.msgtype) {
    case 'm.image': return <><Img client={client} c={c} />{caption(c)}</>
    case 'm.video': return <><Video client={client} c={c} />{caption(c)}</>
    case 'm.audio': return <><Audio client={client} c={c} /><Transcript client={client} room={room} ev={ev} /></>
    case 'm.file': return <FileLink client={client} c={c} />
    case 'm.location': return <a href={geoLink(c.geo_uri)} target="_blank" rel="noreferrer">📍 {c.body || 'Location'}</a>
    case 'm.emote': return <span className="text"><i>* {c.body}</i></span>
    default: return hasRichFormatting(c) ? <Rich html={c.formatted_body} members={members} /> : <span className="text">{linkify(stripReply(c.body || ''))}</span>
  }
}

// Bridges put the file name in body; if there's a separate caption, show it.
function caption(c) {
  const cap = c.filename && c.body && c.body !== c.filename ? c.body : null
  return cap ? <span className="text">{linkify(cap)}</span> : null
}

function Img({ client, c, sticker }) {
  const thumb = useMedia(client, c.info?.thumbnail_url || c.url, 640)
  const [view, setView] = useState(false)
  const w = c.info?.w || 320
  const h = c.info?.h || 240
  const ratio = Math.min(1, (sticker ? 160 : 280) / w)
  return (
    <>
      <button className={`media ${sticker ? 'sticker' : ''}`} style={{ width: w * ratio, aspectRatio: `${w} / ${h}` }}
        onClick={(e) => { e.stopPropagation(); if (!sticker) setView(true) }}>
        {thumb ? <img src={thumb} alt={c.body || ''} draggable={false} /> : <span className="spinner small" />}
      </button>
      {view && createPortal(<Viewer client={client} c={c} thumb={thumb} onClose={() => setView(false)} />, document.body)}
    </>
  )
}

// Full-screen photo: pinch or double-tap to zoom, drag to look around, swipe down or ✕ to
// close. Long-press the photo on the iPhone to save it; "Save" downloads it elsewhere.
export function Viewer({ client, c, thumb, onClose }) {
  const [full, setFull] = useState(() => client.mediaCached(c.url, { download: true }))
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 })
  const [drag, setDrag] = useState(0) // swipe-down distance when not zoomed
  const g = useRef({})
  useEffect(() => { client.mediaUrl(c.url, { download: true })?.then(setFull).catch(() => {}) }, [c.url])
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  function onTouchStart(e) {
    const t = e.touches
    if (t.length === 2) g.current = { pinch: dist(t), s: z.s }
    else if (t.length === 1) {
      const now = Date.now()
      if (now - (g.current.tap || 0) < 280) { setZ(z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }); g.current.tap = 0; return }
      g.current = { tap: now, x: t[0].clientX, y: t[0].clientY, ox: z.x, oy: z.y }
    }
  }
  function onTouchMove(e) {
    const t = e.touches
    e.preventDefault()
    if (t.length === 2 && g.current.pinch) { setZ((v) => ({ ...v, s: Math.min(5, Math.max(1, g.current.s * dist(t) / g.current.pinch)) })); return }
    if (t.length !== 1 || g.current.x === undefined) return
    const dx = t[0].clientX - g.current.x
    const dy = t[0].clientY - g.current.y
    if (z.s > 1) setZ((v) => ({ ...v, x: g.current.ox + dx, y: g.current.oy + dy }))
    else setDrag(Math.max(0, dy))
  }
  function onTouchEnd() {
    if (z.s <= 1 && drag > 120) { onClose(); return }
    setDrag(0)
    if (z.s < 1.05) setZ({ s: 1, x: 0, y: 0 })
  }
  const src = full || thumb
  return (
    <div className="viewer" role="dialog" aria-label="Photo" style={{ background: `rgba(0,0,0,${Math.max(0.3, 1 - drag / 400)})` }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      onDoubleClick={() => setZ(z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 })}>
      {src ? <img src={src} alt={c.body || ''} style={{ transform: `translate(${z.x}px, ${z.y + drag}px) scale(${z.s})` }} />
        : <span className="spinner" />}
      <div className="viewer-bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        {full && !isNative && <a className="text-btn" href={full} download={c.filename || c.body || 'photo.jpg'} onClick={(e) => e.stopPropagation()}>Save</a>}
        {isNative && <span className="viewer-hint">Hold the photo to save</span>}
      </div>
    </div>
  )
}

// Videos keep their own shape (portrait phone videos too), up to 320 × 420, before and
// while playing — a fixed small 16:9 box made them tiny until you went full screen.
function videoBox(info) {
  const w = info?.w || info?.thumbnail_info?.w || 16
  const h = info?.h || info?.thumbnail_info?.h || 9
  const k = Math.min(320 / w, 420 / h)
  return { width: Math.round(w * k), aspectRatio: `${w} / ${h}` }
}

function Video({ client, c }) {
  const [src, setSrc] = useState(null)
  const [playing, setPlaying] = useState(false)
  const poster = useMedia(client, c.info?.thumbnail_url, 640)
  const box = videoBox(c.info)
  const ref = useRef(null)
  // No preview picture (WhatsApp's bridge doesn't send one): once the video scrolls into
  // view, load it and show its first frame instead of an empty box. Large ones wait for a tap.
  const autoLoad = !c.info?.thumbnail_url && (c.info?.size || 0) <= 25 * 1024 * 1024
  useEffect(() => {
    if (!autoLoad || src || !ref.current) return
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); client.mediaUrl(c.url, { download: true })?.then(setSrc).catch(() => {}) }
    }, { rootMargin: '200px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [autoLoad, src, c.url, client])
  if (src) {
    return (
      <video className="media-video" style={box} src={`${src}#t=0.1`} poster={poster || undefined}
        controls preload="metadata" playsInline autoPlay={playing} onClick={(e) => e.stopPropagation()} />
    )
  }
  return (
    <button ref={ref} className="media video-ph" style={box} onClick={(e) => { e.stopPropagation(); setPlaying(true); client.mediaUrl(c.url, { download: true })?.then(setSrc) }}>
      {poster && <img src={poster} alt="" />}<span className="play">▶</span>
    </button>
  )
}

// Voice speed (1× → 1.5× → 2×, like WhatsApp), remembered on this device for every voice message.
const SPEEDS = [1, 1.5, 2]
const savedSpeed = () => { try { const v = +localStorage.getItem('inbox.voiceSpeed'); return SPEEDS.includes(v) ? v : 1 } catch { return 1 } }
let voiceSpeed = savedSpeed()
const speedListeners = new Set()

function Audio({ client, c }) {
  const [src, setSrc] = useState(null)
  const [speed, setSpeed] = useState(voiceSpeed)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(((c.info?.duration || 0) / 1000) || 0)
  const el = useRef(null)
  const bar = useRef(null)
  useEffect(() => { client.mediaUrl(c.url, { download: true })?.then(setSrc).catch(() => {}) }, [c.url])
  useEffect(() => { const on = (v) => setSpeed(v); speedListeners.add(on); return () => speedListeners.delete(on) }, [])
  useEffect(() => { if (el.current) { el.current.playbackRate = speed; el.current.defaultPlaybackRate = speed } }, [speed, src])
  const voice = c['org.matrix.msc3245.voice'] !== undefined
  const stop = (e) => e.stopPropagation()
  function nextSpeed(e) {
    e.stopPropagation()
    voiceSpeed = SPEEDS[(SPEEDS.indexOf(voiceSpeed) + 1) % SPEEDS.length]
    try { localStorage.setItem('inbox.voiceSpeed', String(voiceSpeed)) } catch {}
    for (const fn of speedListeners) fn(voiceSpeed)
  }
  function toggle(e) {
    e.stopPropagation()
    const a = el.current
    if (!a) return
    if (a.paused) { a.playbackRate = voiceSpeed; a.play().catch(() => {}) } else a.pause()
  }
  // tap or drag along the line to jump
  function seek(e) {
    e.stopPropagation()
    const a = el.current
    const r = bar.current?.getBoundingClientRect()
    if (!a || !r || !dur) return
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - r.left
    a.currentTime = Math.max(0, Math.min(1, x / r.width)) * dur
    setCur(a.currentTime)
  }
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0
  return (
    <div className="audio voice" onClick={stop} onContextMenu={stop}>
      <button className="voice-play" onClick={toggle} disabled={!src} aria-label={playing ? 'Pause' : 'Play'}>
        {!src ? <span className="spinner small" /> : playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-main">
        <div className="voice-track" ref={bar} onClick={seek} onTouchStart={seek} onTouchMove={seek}>
          <div className="voice-fill" style={{ width: `${pct}%` }} />
          <div className="voice-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="voice-time">{voice ? '🎤 ' : '🎵 '}{playing || cur > 0 ? `${fmtDur(cur * 1000)} / ${fmtDur(dur * 1000)}` : fmtDur(dur * 1000)}</div>
      </div>
      <button className="speed" onClick={nextSpeed} aria-label={`Playback speed ${speed}×`}>{speed}×</button>
      {src && <audio ref={el} src={src} preload="metadata"
        onLoadedMetadata={(e) => { if (isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setDur(e.currentTarget.duration) }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onPlay={(e) => { e.currentTarget.playbackRate = voiceSpeed; setPlaying(true) }}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCur(0) }} />}
    </div>
  )
}

function FileLink({ client, c }) {
  const size = c.info?.size ? ` · ${(c.info.size / 1024 / 1024).toFixed(1)} MB` : ''
  return (
    <button className="file" onClick={(e) => {
      e.stopPropagation()
      client.mediaUrl(c.url, { download: true })?.then((u) => { const a = document.createElement('a'); a.href = u; a.download = c.filename || c.body || 'file'; a.click() })
    }}>📎 {c.filename || c.body}{size}</button>
  )
}

function geoLink(uri) {
  const m = /geo:([-\d.]+),([-\d.]+)/.exec(uri || '')
  return m ? `https://maps.apple.com/?ll=${m[1]},${m[2]}` : '#'
}

function linkify(text) {
  const parts = text.split(/(https?:\/\/[^\s]+|(?:www\.|[a-z0-9-]+\.(?:com|lt|org|net|io|me|fit)\/)[^\s]*)/gi)
  return parts.map((p, i) => (i % 2 ? <a key={i} href={p.startsWith('http') ? p : 'https://' + p} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{p}</a> : p))
}

// Voice notes: the browser records with whatever it supports (iPhone: AAC/mp4,
// Chrome: Opus/webm); the bridges convert it to each app's voice format.
// WhatsApp only takes Ogg/Opus voice notes, so record Opus (WebM on Chrome and
// iPhone) and re-wrap it as Ogg before sending; iMessage gets MP4/AAC, which
// Messages plays natively.
const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
const IMESSAGE_VOICE_TYPES = ['audio/mp4', ...VOICE_TYPES]
const MAX_VOICE_MS = 5 * 60_000
const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

function useRecorder(onDone) {
  const [rec, setRec] = useState(null) // { start } while recording
  const [, tick] = useState(0)
  const r = useRef({})
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => {
      tick((x) => x + 1)
      if (Date.now() - rec.start > MAX_VOICE_MS) stop(true)
    }, 250)
    return () => clearInterval(t)
  }, [rec])
  async function start(net) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = (net === 'imessage' || net === 'sms' ? IMESSAGE_VOICE_TYPES : VOICE_TYPES).find((t) => window.MediaRecorder?.isTypeSupported?.(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks = []
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    r.current = { stream, recorder, chunks, start: Date.now() }
    recorder.start(250)
    setRec({ start: r.current.start })
  }
  function stop(send) {
    const { stream, recorder, chunks, start: began } = r.current
    if (!recorder) return
    r.current = {}
    setRec(null)
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const ms = Date.now() - began
      if (send && ms > 600 && chunks.length) onDone(new Blob(chunks, { type: recorder.mimeType || chunks[0].type }), ms)
    }
    recorder.stop()
  }
  useEffect(() => () => { if (r.current.recorder) stop(false) }, [])
  return { rec, start, stop, elapsed: rec ? Date.now() - rec.start : 0 }
}

// Reply suggestions the server prepared for the newest message in this chat (server/suggest),
// shown only while that message is still the last one and he hasn't replied.
export function suggestionsFor(room, me) {
  const s = room?.suggest
  if (!s?.replies?.length) return []
  const last = [...(room.timeline || [])].reverse().find((e) => e.type === 'm.room.message' && !e.local)
  if (!last || last.sender === me || last.event_id !== s.event_id) return []
  return s.replies
}

function Composer({ ctx, item, target, replyTo, editing, onEdit, onCancelEdit, lastEditable, onClearReply, onSent }) {
  const { client, model } = ctx
  const [text, setText] = useState('')
  const [err, setErr] = useState(null)
  const suggested = suggestionsFor(client.rooms[target], client.userId)
  const useSuggestion = (s) => { setText(s); setTimeout(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(s.length, s.length) } }, 0) }
  const [pending, setPending] = useState([]) // photos/files picked, waiting for a caption + send
  const [mentions, setMentions] = useState([]) // [{ name, userId }] picked from the @ list
  const [menu, setMenu] = useState(null) // null | 'menu' | 'poll'
  const room = client.rooms[target]
  const feats = room?.features || {}
  const isGroupRoom = model.info[target]?.kind === 'group'
  const canPoll = feats.poll > 0
  const canLocation = feats.location_message > 0
  // @ in a group: who's in it
  const mq = isGroupRoom ? mentionQuery(text) : null
  const memberHits = mq === null ? [] : Object.entries(room?.members || {})
    .filter(([uid, m]) => m.membership === 'join' && uid !== client.userId && !/bot:/.test(uid) && m.displayname)
    .map(([uid, m]) => ({ userId: uid, name: cleanName(m.displayname) }))
    .filter((m) => !mq || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(mq.toLowerCase())))
    .slice(0, 6)
  function pickMention(m) {
    const t = text.replace(/@([^\s@]{0,30})$/, `@${m.name} `)
    setText(t)
    setMentions((list) => [...list.filter((x) => x.userId !== m.userId), m])
    setTimeout(() => area.current?.focus(), 0)
  }
  async function shareLocation() {
    setMenu(null)
    if (!navigator.geolocation) { setErr('Location isn’t available here.'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => { onSent(); client.sendLocation(target, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy).catch((e) => setErr(`Couldn't send the location: ${e.message}`)) },
      (e) => setErr(e.code === 1 ? 'Inbox isn’t allowed to use your location. Allow it in Settings.' : `Couldn't get your location: ${e.message}`),
      { enableHighAccuracy: true, timeout: 15000 })
  }
  const fileInput = useRef(null)
  const cameraInput = useRef(null)
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  const typingAt = useRef(0)
  const area = useRef(null)
  const net = model.info[target]?.network
  const voice = useRecorder(async (blob, ms) => {
    onSent()
    try { await client.sendVoice(target, blob, ms) } catch (e) { setErr(`Couldn't send the voice message: ${e.message}`) }
  })
  const canRecord = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

  // something shared in from another app (iPhone share sheet) for this chat: put it in the box
  useEffect(() => {
    const take = () => {
      const d = takeSharedDraft(item.key)
      if (!d) return
      if (d.files?.length) addFiles(d.files)
      if (d.text) setText((t) => (t ? `${t}\n${d.text}` : d.text))
    }
    take()
    return onSharedDraft((key) => { if (key === item.key) take() })
  }, [item.key])

  // tell iOS you message this chat (share-sheet suggestions), with their photo
  function donate() {
    if (!isNative) return
    const p = item.avatarUrl ? client.mediaUrl(item.avatarUrl, { width: 96 }) : null
    Promise.resolve(p).then((u) => (u ? fetch(u).then((r) => r.blob()) : null)).catch(() => null)
      .then((blob) => donateConversation(item.key, item.name, blob))
  }

  // editing: the message goes into the box; Enter saves, Esc (or ✕) cancels
  const editKey = editing?.ev.event_id
  useEffect(() => {
    if (!editing) return
    const t = stripReply(editing.ev.content?.body || '')
    setText(t)
    setTimeout(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }, 0)
  }, [editKey])
  function cancelEdit() { onCancelEdit(); setText('') }

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  function onChange(e) {
    setText(e.target.value)
    if (Date.now() - typingAt.current > 4000 && e.target.value) { typingAt.current = Date.now(); client.typing(target, true) }
  }

  async function send() {
    const body = text.trim()
    if (pending.length) return sendPending(body)
    if (editing) {
      const { ev, roomId } = editing
      cancelEdit()
      if (!body || body === stripReply(ev.content?.body || '')) return
      try { await client.edit(roomId, ev.event_id, body) } catch (e) { setErr(`Couldn't edit: ${e.message}`) }
      return
    }
    if (!body) return
    setText('')
    setErr(null)
    typingAt.current = 0
    client.typing(target, false)
    const content = { msgtype: 'm.text', body }
    // *bold* _italic_ ~strike~ `code` and @mentions go as formatting the app understands
    const used = mentions.filter((m) => body.includes('@' + m.name))
    const html = markdownToHtml(body, used)
    if (html) { content.format = 'org.matrix.custom.html'; content.formatted_body = html }
    if (used.length) content['m.mentions'] = { user_ids: [...new Set(used.map((m) => m.userId))] }
    setMentions([])
    if (replyTo && replyTo.roomId === target) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo.ev.event_id } }
    onSent()
    donate()
    try { await client.send(target, content) } catch (e) { setErr(`Couldn't send: ${e.message}`) }
  }

  // Picked files wait above the text field so you can add a caption (like WhatsApp).
  function addFiles(files) {
    if (!files.length) return
    setPending((p) => [...p, ...files.map((file) => ({ file, url: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null }))])
    setTimeout(() => area.current?.focus(), 0)
  }

  // in the iPhone app the photo library opens directly; in the browser, the file picker
  async function openPicker() {
    if (!isNative) { fileInput.current?.click(); return }
    try { addFiles(await pickPhotos()) } catch (e) { setErr(`Couldn't open your photos: ${e.message}`) }
  }

  function onFiles(e) {
    const files = [...e.target.files]
    e.target.value = ''
    addFiles(files)
  }

  // ⌘V of a screenshot or a copied file: queue it like a picked photo (text pastes as usual)
  function onPaste(e) {
    const cd = e.clipboardData
    let files = [...(cd?.files || [])]
    if (!files.length) files = [...(cd?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault()
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
    addFiles(files.map((f, i) => (/^image\.(png|jpe?g|gif|webp|heic)$/i.test(f.name) || !f.name
      ? new File([f], `Screenshot ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })
      : f)))
  }

  // drag files from Finder onto the message box
  const [dragging, setDragging] = useState(false)
  const dropProps = {
    onDragOver: (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragging(true) } },
    onDragLeave: () => setDragging(false),
    onDrop: (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer.files]) } },
  }

  function removePending(i) {
    setPending((p) => { if (p[i]?.url) URL.revokeObjectURL(p[i].url); return p.filter((_, j) => j !== i) })
  }

  async function sendPending(caption) {
    const items = pending
    setPending([])
    setText('')
    setErr(null)
    onSent()
    donate()
    for (let i = 0; i < items.length; i++) {
      const { file, url } = items[i]
      // the caption goes with the first photo, as in WhatsApp
      try { await client.sendFile(target, file, i === 0 ? caption : '') } catch (er) { setErr(`Couldn't send ${file.name}: ${er.message}`) }
      if (url) URL.revokeObjectURL(url)
    }
  }

  async function startVoice() {
    setErr(null)
    try { await voice.start(net) } catch (e) {
      setErr(e.name === 'NotAllowedError' ? 'Inbox isn’t allowed to use the microphone. Allow it in your phone’s settings for this app.' : `Can’t record: ${e.message}`)
    }
  }

  const color = { '--net': networkInfo(net).color }
  return (
    <div className="composer">
      {editing && (
        <div className="reply-bar edit-bar">
          <Icon name="edit" size={16} />
          <span>Editing: {previewText(editing.ev, client.userId).replace(/^You: /, '')}</span>
          <button className="icon-btn" onClick={cancelEdit} aria-label="Cancel editing"><Icon name="close" size={16} /></button>
        </div>
      )}
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" size={16} />
          <span>{previewText(replyTo.ev, client.userId)}</span>
          <button className="icon-btn" onClick={onClearReply} aria-label="Cancel reply"><Icon name="close" size={16} /></button>
        </div>
      )}
      {err && <div className="error small">{err}</div>}
      {memberHits.length > 0 && (
        <div className="mention-list" role="listbox" aria-label="Mention someone">
          {memberHits.map((m) => <button key={m.userId} onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(m)}>@{m.name}</button>)}
        </div>
      )}
      {menu === 'menu' && (
        <div className="attach-menu">
          <button onClick={() => { setMenu(null); openPicker() }}><Icon name="gallery" size={18} /> Photos & files</button>
          {canPoll && <button onClick={() => setMenu('poll')}><Icon name="poll" size={18} /> Poll</button>}
          {canLocation && <button onClick={shareLocation}><Icon name="pin" size={18} /> Location</button>}
        </div>
      )}
      {menu === 'poll' && <PollSheet max={feats.poll_max_options || 12} multiOnly={!!feats.poll_multiple_choice_only} onClose={() => setMenu(null)}
        onSend={(q, answers, multi) => { setMenu(null); onSent(); client.sendPoll(target, q, answers, multi ? answers.length : 1).catch((e) => setErr(`Couldn't send the poll: ${e.message}`)) }} />}
      {!text && !editing && !pending.length && !voice.rec && suggested.length > 0 && (
        <div className="suggestions" aria-label="Suggested replies">
          {suggested.map((s) => <button key={s} className="suggestion" onClick={() => useSuggestion(s)}>{s}</button>)}
        </div>
      )}
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((p, i) => (
            <div key={i} className="pending-item">
              {p.url && p.file.type.startsWith('image/') ? <img src={p.url} alt="" />
                : p.url ? <video src={p.url} muted playsInline />
                : <span className="pending-file">📎 {p.file.name}</span>}
              <button className="pending-remove" onClick={() => removePending(i)} aria-label={`Remove ${p.file.name}`}><Icon name="close" size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {voice.rec ? (
        <div className="compose-row recording">
          <button className="icon-btn danger" onClick={() => voice.stop(false)} aria-label="Cancel voice message"><Icon name="trash" /></button>
          <span className="rec-dot" />
          <span className="rec-time">{fmtDur(voice.elapsed)}</span>
          <span className="rec-hint">Recording for {networkInfo(net).name}…</span>
          <button className="send" onClick={() => voice.stop(true)} aria-label="Send voice message" style={color}><Icon name="send" /></button>
        </div>
      ) : (
        <div className={`compose-row${dragging ? ' dragging' : ''}`} {...dropProps}>
          {/* One picker for photos, videos and files (on the iPhone it opens Apple's menu:
              Photo Library / Take Photo or Video / Choose Files; a web app can't skip it),
              plus a camera button on phones that goes straight to the camera. */}
          <button className="icon-btn" onClick={openPicker} aria-label={touch ? 'Photos and videos' : 'Attach files'}>
            <Icon name={touch ? 'gallery' : 'plus'} />
          </button>
          {(canPoll || canLocation) && <button className="icon-btn" onClick={() => setMenu(menu ? null : 'menu')} aria-label="Poll, location" aria-expanded={!!menu}><Icon name="more" /></button>}
          {touch && !text && <button className="icon-btn" onClick={() => cameraInput.current?.click()} aria-label="Take a photo or video"><Icon name="camera" /></button>}
          <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
          <input ref={cameraInput} type="file" accept="image/*,video/*" capture="environment" hidden onChange={onFiles} />
          <textarea
            ref={area} rows={1} value={text} onChange={onChange} onPaste={onPaste}
            placeholder={editing ? 'Edit your message' : pending.length ? 'Add a caption…' : suggested[0] && !matchMedia('(pointer: coarse)').matches ? `${suggested[0]}   ⇥ Tab` : `Message on ${networkInfo(net).name}`}
            onKeyDown={(e) => {
              // Tab on an empty box takes the first suggestion (like code completion)
              if ((e.key === 'Tab' || e.key === 'Enter') && memberHits.length) { e.preventDefault(); pickMention(memberHits[0]); return }
              if (e.key === 'Tab' && !e.shiftKey && !text && suggested[0] && !editing) { e.preventDefault(); useSuggestion(suggested[0]); return }
              // ↑ in an empty box: edit your last message (like Slack / Telegram desktop)
              if (e.key === 'ArrowUp' && !text && !pending.length && !editing) { const en = lastEditable(); if (en) { e.preventDefault(); onEdit(en) } return }
              if (e.key === 'Escape' && editing) { e.preventDefault(); cancelEdit(); return }
              if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send() }
            }}
          />
          {text.trim() || pending.length || !canRecord
            ? <button className="send" onPointerDown={(e) => e.preventDefault()} onClick={send} disabled={!text.trim() && !pending.length} aria-label="Send" style={color}><Icon name="send" /></button>
            : <button className="send mic" onClick={startVoice} aria-label="Record voice message" style={color}><Icon name="mic" /></button>}
        </div>
      )}
    </div>
  )
}

// "+" in the reaction bar: any emoji — common ones to tap, or type one from your keyboard.
function EmojiSheet({ onPick, onClose, allowed }) {
  const [typed, setTyped] = useState('')
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pick an emoji">
        <input className="search" value={typed} placeholder="Type any emoji…" enterKeyHint="done"
          onChange={(e) => { const g = splitEmojis(e.target.value); setTyped(e.target.value); if (g.length) onPick(g[0]) }} />
        <div className="emoji-grid">
          {(Array.isArray(allowed) ? allowed : EMOJI_GRID).map((k) => <button key={k} onClick={() => onPick(k)}>{k}</button>)}
        </div>
      </div>
    </div>
  )
}

// While this chat is open and Inbox is in front, tell the WhatsApp bridge every 30 s
// (it then shows you online on WhatsApp, like WhatsApp Web, and typing comes through);
// "closed" when you leave or switch away. The bridge goes offline by itself after 75 s.
function useWhatsAppViewing(client, model, item, live = true) {
  const wa = item.rooms.find((id) => model.info[id]?.network === 'whatsapp')
  useEffect(() => {
    if (!wa || !live) return
    let on = false
    const tick = () => {
      const visible = document.visibilityState === 'visible' && document.hasFocus()
      if (visible) { client.viewing(wa, true); on = true } else if (on) { client.viewing(wa, false); on = false }
    }
    tick()
    const t = setInterval(tick, 30000)
    const now = () => tick()
    document.addEventListener('visibilitychange', now)
    window.addEventListener('focus', now)
    window.addEventListener('blur', now)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', now)
      window.removeEventListener('focus', now)
      window.removeEventListener('blur', now)
      if (on) client.viewing(wa, false)
    }
  }, [client, wa, live])
}

// Calls happen in the app that can make them (no bridge carries calls): WhatsApp,
// FaceTime / phone, Messenger. One option opens directly; several show a short menu.
function CallButton({ item, model }) {
  const [open, setOpen] = useState(false)
  if (item.kind !== 'person') return null
  const opts = callOptions(item, model.info)
  if (!opts.length) return null
  const go = (href) => { setOpen(false); openExternal(href).catch(() => {}) }
  return (
    <>
      <button className="icon-btn" aria-label={`Call ${item.name}`} onClick={() => (opts.length === 1 ? go(opts[0].href) : setOpen(true))}><Icon name="phone" /></button>
      {open && createPortal(
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet call-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Call ${item.name}`}>
            <h3>Call {item.name}</h3>
            <p className="muted small">Calls open in the app that makes them.</p>
            {opts.map((o) => <button key={o.href} className="wide-btn" onClick={() => go(o.href)}>{o.label}</button>)}
            <button className="text-btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>,
        document.body, // not inside the header: its blur would trap a fixed overlay
      )}
    </>
  )
}

// A poll (WhatsApp, Messenger groups): tap an answer to vote; results show who voted.
function Poll({ client, room, ev, votes, onVote }) {
  const poll = pollOf(ev)
  if (!poll) return null
  const me = client.userId
  const tally = tallyPoll(poll, votes || {})
  const mine = new Set((votes || {})[me] || [])
  const total = new Set(Object.values(tally).flat()).size
  const canVote = room?.features?.poll > 0
  const name = (uid) => uid === me ? 'You' : cleanName(room?.members?.[uid]?.displayname || '').split(' ')[0] || 'Someone'
  function toggle(id) {
    if (!canVote) return
    let next
    if (poll.max <= 1) next = mine.has(id) ? [] : [id]
    else next = mine.has(id) ? [...mine].filter((x) => x !== id) : [...mine, id].slice(-poll.max)
    onVote(next)
  }
  return (
    <div className="poll">
      <div className="poll-q">📊 {poll.question}</div>
      <div className="muted small">{poll.max > 1 ? 'Pick one or more' : 'Pick one'}{!canVote && ' · vote in the app'}</div>
      {poll.answers.map((a) => {
        const who = tally[a.id] || []
        const pct = total ? Math.round((who.length / total) * 100) : 0
        return (
          <button key={a.id} className={`poll-a ${mine.has(a.id) ? 'on' : ''}`} onClick={() => toggle(a.id)} disabled={!canVote}>
            <span className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-check">{mine.has(a.id) ? '✓' : ''}</span>
            <span className="poll-text">{a.text}</span>
            <span className="poll-n" title={who.map(name).join(', ')}>{who.length || ''}</span>
          </button>
        )
      })}
      {total > 0 && <div className="muted small">{total} voted · {Object.entries(tally).filter(([, w]) => w.length).map(([id, w]) => `${poll.answers.find((a) => a.id === id)?.text}: ${w.map(name).join(', ')}`).join(' · ')}</div>}
    </div>
  )
}

function PollSheet({ max, multiOnly, onSend, onClose }) {
  const [q, setQ] = useState('')
  const [answers, setAnswers] = useState(['', ''])
  const [multi, setMulti] = useState(multiOnly)
  const filled = answers.map((a) => a.trim()).filter(Boolean)
  const set = (i, v) => {
    const next = answers.map((a, j) => (j === i ? v : a))
    if (i === next.length - 1 && v && next.length < max) next.push('')
    setAnswers(next)
  }
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet poll-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New poll">
        <h3>New poll</h3>
        <input className="search" autoFocus placeholder="Question" value={q} onChange={(e) => setQ(e.target.value)} />
        {answers.map((a, i) => <input key={i} className="search" placeholder={`Option ${i + 1}`} value={a} maxLength={100} onChange={(e) => set(i, e.target.value)} />)}
        {!multiOnly && <label className="radio"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Allow more than one answer</label>}
        <div className="sugg-actions">
          <button className="text-btn" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!q.trim() || filled.length < 2} onClick={() => onSend(q.trim(), filled, multi)}>Send poll</button>
        </div>
      </div>
    </div>
  )
}

// Forward a message to any chat: pick who, it goes on the app you'd normally use with them.
function ForwardSheet({ ctx, en, onClose, onDone }) {
  const { client, model } = ctx
  const [q, setQ] = useState('')
  const nq = q.trim().toLowerCase()
  const list = model.items.filter((i) => i.kind !== 'connection' && (!nq || i.name.toLowerCase().includes(nq))).slice(0, 40)
  async function send(item) {
    const roomId = chooseChannel(item, client.rooms, client.userId, { windowHours: model.config.replyWindowHours }).roomId || item.rooms[0]
    try { await client.forward(en.ev, roomId); onDone(item.name) } catch (e) { alert(`Couldn't forward: ${e.message}`) }
  }
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Forward to">
        <h3>Forward to…</h3>
        <input className="search" autoFocus placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="list pick-list">
          {list.map((i) => (
            <li key={i.key}><button className="member-row" onClick={() => send(i)}>
              <Avatar client={client} mxc={i.avatarUrl} name={i.name} size={32} />
              <span className="grow">{i.name}</span>
              <span className="nets">{i.networks.slice(0, 2).map((n) => <NetBadge key={n} net={n} />)}</span>
            </button></li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// Messenger / Instagram "message requests": someone new wrote; accept or delete.
function RequestBanner({ ctx, item }) {
  const { client, model } = ctx
  const roomId = item.rooms.find((id) => client.rooms[id]?.bridge?.channel?.['com.beeper.message_request'])
  const [busy, setBusy] = useState(false)
  if (!roomId) return null
  const app = networkInfo(model.info[roomId]?.network).name
  return (
    <div className="contact-prompt request-banner">
      <span><b>Message request</b> on {app}. They won't know you've seen it until you accept or reply.</span>
      <button className="text-btn inline" disabled={busy} onClick={async () => { setBusy(true); await client.acceptRequest(roomId).catch(() => {}); client.rooms[roomId].bridge.channel['com.beeper.message_request'] = false; setBusy(false) }}>Accept</button>
      <button className="text-btn inline danger" disabled={busy} onClick={async () => { if (confirm(`Delete this request on ${app}?`)) { await client.deleteChat(roomId, { fromRequest: true }).catch(() => {}); go('inbox') } }}>Delete</button>
    </div>
  )
}

// The voice message as text (sky transcribes new ones by itself; older ones on request).
function Transcript({ client, room, ev }) {
  const [open, setOpen] = useState(false)
  if (!room || ev.local) return null
  const t = room.transcripts?.t?.[ev.event_id]
  const ask = (again) => (e) => { e.stopPropagation(); client.requestTranscript(room.id, ev.event_id, again).catch(() => {}) }
  if (!t) return <button className="transcript-btn" onClick={ask(false)}>Transcribe</button>
  if (t.pending) return <TranscribeProgress t={t} />
  if (t.error) return <button className="transcript-btn" onClick={ask(true)}>Couldn't transcribe · Try again</button>
  if (!t.text) return <div className="transcript muted">(no speech)</div>
  const long = t.text.length > 220
  return (
    <div className="transcript" onClick={(e) => { if (long) { e.stopPropagation(); setOpen(!open) } }}>
      {long && !open ? t.text.slice(0, 200) + '…' : t.text}
      {(open || !long) && <button className="transcript-again" onClick={ask(true)}>Transcribe again</button>}
    </div>
  )
}

// "Transcribing 45% · ~12 s left" with a line that fills; the seconds count down here
// between sky's updates (every ~3 s).
function TranscribeProgress({ t }) {
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i) }, [])
  const pct = Math.max(1, Math.min(99, t.progress || 0))
  const left = t.eta ? Math.max(1, Math.round((t.eta - Date.now()) / 1000)) : null
  return (
    <div className="transcript-progress">
      <div className="tp-track"><div className="tp-fill" style={{ width: `${pct}%` }} /></div>
      <div className="tp-label">Transcribing {pct}%{left ? ` · ~${left} s left` : ''}</div>
    </div>
  )
}
