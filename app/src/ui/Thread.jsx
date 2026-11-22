import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { go, back } from '../router.js'
import { chooseChannel, mergedTimeline, stripReply, previewText, cleanName, deliveryStatus } from '../people.js'
import { networkInfo } from '../networks.js'
import { Avatar, NetBadge, TopBar, Icon, useMedia, ago, identityOf } from './common.jsx'
import { ContactPrompt } from './PhoneBook.jsx'

// manual channel picks survive navigating away and back (per person, this session)
const overrides = new Map()
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export default function Thread({ ctx, item }) {
  const { client, model } = ctx
  const rooms = client.rooms
  const me = client.userId
  const multi = item.rooms.length > 1
  const isGroup = item.kind === 'group'
  const { entries, hasMore } = mergedTimeline(item, rooms)
  const scroller = useRef(null)
  const atBottom = useRef(true)
  const [loading, setLoading] = useState(false)
  const [replyTo, setReplyTo] = useState(null) // { ev, roomId }
  const [active, setActive] = useState(null) // event id with open action bar
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

  // read receipts while you're looking at it (bridges pass them on to the apps)
  useEffect(() => {
    if (document.visibilityState !== 'visible') return
    for (const id of item.rooms) if (rooms[id]) client.markRead(id)
  }, [ctx.version, item.key])
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') for (const id of item.rooms) client.markRead(id) }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [item.key])

  // no notifications from this person while their chat is open on screen
  const roomsKey = item.rooms.join('|')
  useEffect(() => {
    const apply = () => client.quietRooms(document.visibilityState === 'visible' ? item.rooms : [])
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => { document.removeEventListener('visibilitychange', apply); client.quietRooms([]) }
  }, [roomsKey])

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
  const netCount = {}
  for (const id of item.rooms) netCount[model.info[id]?.network] = (netCount[model.info[id]?.network] || 0) + 1

  return (
    <div className="page thread">
      <TopBar onBack={back}>
        <div className="thread-head">
          <button className="thread-avatar" onClick={() => go('p', item.key)} aria-label={`About ${item.name}`}>
            <Avatar client={client} mxc={item.avatarUrl} name={item.name} size={36} />
          </button>
          <div className="thread-title">
            <button className="thread-name" onClick={() => go('p', item.key)}><h1>{item.name}</h1></button>
            {/* the apps this person is on: the highlighted one is where your message goes; tap another to switch */}
            <div className="thread-sub" role={multi ? 'radiogroup' : undefined} aria-label={multi ? 'Send on' : undefined}>
              {item.rooms.map((id, i) => {
                const n = model.info[id]?.network
                const name = networkInfo(n).name + (netCount[n] > 1 ? ` ${item.rooms.filter((r) => model.info[r]?.network === n).indexOf(id) + 1}` : '')
                const on = id === target
                return multi ? (
                  <button key={id} role="radio" aria-checked={on} className={`ch-pick ${on ? 'on' : ''}`} style={{ '--net': networkInfo(n).color }}
                    onClick={() => pick(id)} aria-label={`${name}${on ? `, sending here (${why})` : ''}`} title={`${name} · ${identityOf(client, model.info, id)}${on ? ` · sending here (${why})` : ''}`}>
                    <NetBadge net={n} />{netCount[n] > 1 && <sub>{name.split(' ').pop()}</sub>}
                  </button>
                ) : <NetBadge key={id} net={n} label />
              })}
              {typing.length > 0 && <i className="typing-label">typing…</i>}
            </div>
          </div>
        </div>
      </TopBar>
      <ContactPrompt ctx={ctx} item={item} />
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
                onReply={() => { setReplyTo(en); setActive(null) }}
                onReact={(k) => { client.react(en.roomId, en.ev.event_id, k).catch(() => {}); setActive(null) }}
              />
            </React.Fragment>
          )
        })}
        {typing.length > 0 && <div className="typing"><span /><span /><span /></div>}
      </div>
      <Composer
        ctx={ctx} target={target} replyTo={replyTo}
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

const TICKS = { sending: '◌', sent: '✓', delivered: '✓✓', seen: '✓✓' }
const TICK_TITLE = { sending: 'Sending', sent: 'Sent to your server', delivered: 'Delivered', seen: 'Seen' }

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

function Bubble({ ctx, en, mine, first, last, showNet, multi, showSender, status, seenHere, open, onOpen, onReply, onReact }) {
  const { client, model } = ctx
  const press = useLongPress(onOpen)
  const { ev, roomId, reactions } = en
  const room = client.rooms[roomId]
  const net = model.info[roomId]?.network
  const c = ev.content || {}
  const notice = c.msgtype === 'm.notice' && !mine
  const replyId = c['m.relates_to']?.['m.in_reply_to']?.event_id
  const quoted = replyId ? room?.byId[replyId] : null
  const time = new Date(ev.origin_server_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className={`msg ${mine ? 'out' : 'in'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${notice ? 'notice' : ''}`} style={{ '--net': networkInfo(net).color }}>
      {showNet && <div className="msg-net"><NetBadge net={net} label /></div>}
      {showSender && <div className="msg-sender">{cleanName(room?.members[ev.sender]?.displayname || ev.sender)}</div>}
      <div className={`bubble ${open ? 'pressed' : ''}`} {...press}>
        {replyId && (
          <div className="quote">{quoted ? previewText(quoted, client.userId).replace(/^You: /, '') : 'Replying to an earlier message'}</div>
        )}
        <MessageBody client={client} ev={ev} />
        <span className="meta">
          {ev.edited && 'edited · '}
          {time}
          {multi && <i className="dot" title={networkInfo(net).name} />}
          {status && status !== 'failed' && <span className={`ticks ${status}`} title={TICK_TITLE[status]}>{TICKS[status]}</span>}
        </span>
      </div>
      {seenHere && <div className="seen">Seen</div>}
      {ev.status === 'failed' && (
        <button className="failed" onClick={() => client.retry(roomId, ev.event_id).catch(() => {})}>Not sent. Tap to retry</button>
      )}
      {reactions && (
        <div className="reactions">
          {Object.values(reactions).map((r) => <span key={r.key} className={r.senders.includes(client.userId) ? 'mine' : ''}>{r.key}{r.count > 1 && ` ${r.count}`}</span>)}
        </div>
      )}
      {open && !ev.local && (
        <div className="actions" onClick={(e) => e.stopPropagation()} role="toolbar" aria-label="Message actions">
          {QUICK.map((k) => <button key={k} onClick={() => onReact(k)}>{k}</button>)}
          <button onClick={onReply} aria-label="Reply"><Icon name="reply" size={18} /></button>
          {c.body && <button onClick={() => navigator.clipboard?.writeText(stripReply(c.body))}>Copy</button>}
        </div>
      )}
    </div>
  )
}

function MessageBody({ client, ev }) {
  const c = ev.content || {}
  if (ev.redacted || ev.unsigned?.redacted_because) return <span className="muted"><i>Message deleted</i></span>
  if (ev.type === 'm.sticker') return <Img client={client} c={c} sticker />
  switch (c.msgtype) {
    case 'm.image': return <><Img client={client} c={c} />{caption(c)}</>
    case 'm.video': return <><Video client={client} c={c} />{caption(c)}</>
    case 'm.audio': return <Audio client={client} c={c} />
    case 'm.file': return <FileLink client={client} c={c} />
    case 'm.location': return <a href={geoLink(c.geo_uri)} target="_blank" rel="noreferrer">📍 {c.body || 'Location'}</a>
    case 'm.emote': return <span className="text"><i>* {c.body}</i></span>
    default: return <span className="text">{linkify(stripReply(c.body || ''))}</span>
  }
}

// Bridges put the file name in body; if there's a separate caption, show it.
function caption(c) {
  const cap = c.filename && c.body && c.body !== c.filename ? c.body : null
  return cap ? <span className="text">{linkify(cap)}</span> : null
}

function Img({ client, c, sticker }) {
  const thumb = useMedia(client, c.info?.thumbnail_url || c.url, 640)
  const w = c.info?.w || 320
  const h = c.info?.h || 240
  const ratio = Math.min(1, (sticker ? 160 : 280) / w)
  return (
    <button className={`media ${sticker ? 'sticker' : ''}`} style={{ width: w * ratio, aspectRatio: `${w} / ${h}` }}
      onClick={(e) => { e.stopPropagation(); client.mediaUrl(c.url, { download: true })?.then((u) => window.open(u, '_blank')) }}>
      {thumb ? <img src={thumb} alt={c.body || ''} /> : <span className="spinner small" />}
    </button>
  )
}

function Video({ client, c }) {
  const [src, setSrc] = useState(null)
  const poster = useMedia(client, c.info?.thumbnail_url, 640)
  if (src) return <video className="media-video" src={src} controls autoPlay playsInline />
  return (
    <button className="media video-ph" onClick={(e) => { e.stopPropagation(); client.mediaUrl(c.url, { download: true })?.then(setSrc) }}>
      {poster && <img src={poster} alt="" />}<span className="play">▶</span>
    </button>
  )
}

function Audio({ client, c }) {
  const [src, setSrc] = useState(null)
  useEffect(() => { client.mediaUrl(c.url, { download: true })?.then(setSrc).catch(() => {}) }, [c.url])
  const voice = c['org.matrix.msc3245.voice'] !== undefined
  return <div className="audio">{voice ? '🎤' : '🎵'} {src ? <audio src={src} controls preload="metadata" onClick={(e) => e.stopPropagation()} /> : <span className="spinner small" />}</div>
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
    const mimeType = (net === 'imessage' ? IMESSAGE_VOICE_TYPES : VOICE_TYPES).find((t) => window.MediaRecorder?.isTypeSupported?.(t))
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

function Composer({ ctx, target, replyTo, onClearReply, onSent }) {
  const { client, model } = ctx
  const [text, setText] = useState('')
  const [err, setErr] = useState(null)
  const [pending, setPending] = useState([]) // photos/files picked, waiting for a caption + send
  const fileInput = useRef(null)
  const typingAt = useRef(0)
  const area = useRef(null)
  const net = model.info[target]?.network
  const voice = useRecorder(async (blob, ms) => {
    onSent()
    try { await client.sendVoice(target, blob, ms) } catch (e) { setErr(`Couldn't send the voice message: ${e.message}`) }
  })
  const canRecord = typeof window !== 'undefined' && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia

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
    if (!body) return
    setText('')
    setErr(null)
    typingAt.current = 0
    client.typing(target, false)
    const content = { msgtype: 'm.text', body }
    if (replyTo && replyTo.roomId === target) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo.ev.event_id } }
    onSent()
    try { await client.send(target, content) } catch (e) { setErr(`Couldn't send: ${e.message}`) }
  }

  // Picked files wait above the text field so you can add a caption (like WhatsApp).
  function onFiles(e) {
    const files = [...e.target.files]
    e.target.value = ''
    setPending((p) => [...p, ...files.map((file) => ({ file, url: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null }))])
    setTimeout(() => area.current?.focus(), 0)
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
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" size={16} />
          <span>{previewText(replyTo.ev, client.userId)}</span>
          <button className="icon-btn" onClick={onClearReply} aria-label="Cancel reply"><Icon name="close" size={16} /></button>
        </div>
      )}
      {err && <div className="error small">{err}</div>}
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
        <div className="compose-row">
          <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach"><Icon name="attach" /></button>
          <input ref={fileInput} type="file" multiple hidden onChange={onFiles} />
          <textarea
            ref={area} rows={1} value={text} onChange={onChange}
            placeholder={pending.length ? 'Add a caption…' : `Message on ${networkInfo(net).name}`}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send() } }}
          />
          {text.trim() || pending.length || !canRecord
            ? <button className="send" onClick={send} disabled={!text.trim() && !pending.length} aria-label="Send" style={color}><Icon name="send" /></button>
            : <button className="send mic" onClick={startVoice} aria-label="Record voice message" style={color}><Icon name="mic" /></button>}
        </div>
      )}
    </div>
  )
}
