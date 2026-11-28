import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { back } from '../router.js'
import { TopBar, useMedia, usePhoto, Icon } from './common.jsx'
import { LinkCard, urlsIn } from './LinkPreview.jsx'
import { Viewer } from './Thread.jsx'

const enc = encodeURIComponent

// Photos, videos, files and links from all of a person's (or a group's) chats, newest
// first, like WhatsApp's "Media, links and docs".
export async function loadMedia(client, roomIds, { pages = 1, limit = 100 } = {}) {
  const out = []
  for (const id of roomIds) {
    let from = null
    for (let p = 0; p < pages; p++) {
      const query = { dir: 'b', limit: String(limit), filter: JSON.stringify({ types: ['m.room.message', 'm.sticker'] }) }
      if (from) query.from = from
      let res
      try { res = await client.api('GET', `/_matrix/client/v3/rooms/${enc(id)}/messages`, null, { query }) } catch { break }
      for (const ev of res.chunk || []) {
        const c = ev.content || {}
        if (ev.unsigned?.redacted_because) continue
        if (['m.image', 'm.video'].includes(c.msgtype) && c.url) out.push({ kind: 'media', ev, roomId: id })
        else if (c.msgtype === 'm.file' && c.url) out.push({ kind: 'doc', ev, roomId: id })
        else if (c.msgtype === 'm.text') for (const u of urlsIn(c.body)) out.push({ kind: 'link', url: u, ev, roomId: id })
      }
      from = res.end
      if (!from || !(res.chunk || []).length) break
    }
  }
  return out.sort((a, b) => b.ev.origin_server_ts - a.ev.origin_server_ts)
}

export default function MediaPage({ ctx, item }) {
  const { client } = ctx
  const [tab, setTab] = useState('media')
  const [items, setItems] = useState(null)
  const [view, setView] = useState(null)
  useEffect(() => { loadMedia(client, item.rooms, { pages: 4 }).then(setItems) }, [item.key])
  const shown = (items || []).filter((x) => x.kind === tab)
  const counts = { media: 0, doc: 0, link: 0 }
  for (const x of items || []) counts[x.kind]++
  return (
    <div className="page media-page">
      <TopBar onBack={back} title={item.name} />
      <div className="seg media-tabs">
        {[['media', 'Media'], ['link', 'Links'], ['doc', 'Docs']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}{items ? ` ${counts[k] || ''}` : ''}</button>
        ))}
      </div>
      <div className="scroll">
        {!items && <div className="empty-pane"><div className="spinner" /></div>}
        {items && !shown.length && <p className="muted center">Nothing here yet.</p>}
        {tab === 'media' && <div className="media-grid">{shown.map((x) => <Thumb key={x.ev.event_id} client={client} c={x.ev.content} onOpen={() => setView(x.ev.content)} />)}</div>}
        {tab === 'doc' && <ul className="card-list">{shown.map((x) => <Doc key={x.ev.event_id} client={client} x={x} />)}</ul>}
        {tab === 'link' && (
          <ul className="card-list links-list">
            {shown.map((x, i) => (
              <li key={x.ev.event_id + i}>
                <LinkCard client={client} content={x.ev.content} url={x.url} compact />
                <span className="link-meta">
                  <Icon name="link" size={16} />
                  <a className="grow link-row" href={x.url} target="_blank" rel="noreferrer">{x.url.replace(/^https?:\/\//, '')}</a>
                  <span className="muted small">{new Date(x.ev.origin_server_ts).toLocaleDateString()}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view && createPortal(<Viewer client={client} c={view} onClose={() => setView(null)} />, document.body)}
    </div>
  )
}

function Thumb({ client, c, onOpen }) {
  return c.msgtype === 'm.image' ? <PhotoThumb client={client} c={c} onOpen={onOpen} /> : <VideoThumb client={client} c={c} />
}

function PhotoThumb({ client, c, onOpen }) {
  const { url, gone } = usePhoto(client, c, 320)
  const [bad, setBad] = useState(false) // this browser can't draw it (HEIC outside Safari)
  return (
    <button className="media-cell" onClick={gone ? undefined : onOpen} disabled={gone}>
      {url && !bad ? <img src={url} alt="" onError={() => setBad(true)} />
        : gone ? <span className="media-cell-gone">Photo no longer on the server</span>
        : bad ? <span className="media-cell-gone">HEIC photo — open to view</span>
        : <span className="spinner small" />}
    </button>
  )
}

function VideoThumb({ client, c }) {
  const url = useMedia(client, c.info?.thumbnail_url, 320)
  return (
    <button className="media-cell" onClick={() => client.mediaUrl(c.url, { download: true })?.then((u) => window.open(u, '_blank'))}>
      {url ? <img src={url} alt="" /> : <span className="media-cell-icon">🎥</span>}
      <span className="media-cell-badge">▶</span>
    </button>
  )
}

function Doc({ client, x }) {
  const ref = useRef(null)
  const c = x.ev.content
  const open = () => client.mediaUrl(c.url, { download: true })?.then((u) => { const a = ref.current; a.href = u; a.download = c.filename || c.body || 'file'; a.click() })
  return (
    <li className="setting-row" onClick={open} role="button">
      <Icon name="attach" size={18} />
      <span className="grow">{c.filename || c.body || 'File'}</span>
      <span className="muted small">{new Date(x.ev.origin_server_ts).toLocaleDateString()}</span>
      <a ref={ref} hidden />
    </li>
  )
}
