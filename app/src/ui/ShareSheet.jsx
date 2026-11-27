import React, { useState } from 'react'
import { Avatar, NetBadge } from './common.jsx'

// "Send to…" when something was shared to Inbox from another app without picking a person.
export default function ShareSheet({ ctx, share, onPick, onClose }) {
  const { client, model } = ctx
  const [q, setQ] = useState('')
  const nq = q.trim().toLowerCase()
  const list = model.items.filter((i) => i.kind !== 'connection' && (!nq || i.name.toLowerCase().includes(nq))).slice(0, 60)
  const what = share.files.length
    ? `${share.files.length} ${share.files.length === 1 ? 'item' : 'items'}${share.text ? ' + text' : ''}`
    : 'text'
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet share-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Send to">
        <h3>Send {what} to…</h3>
        <input className="search" autoFocus placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="list pick-list">
          {list.map((i) => (
            <li key={i.key}><button className="member-row" onClick={() => onPick(i)}>
              <Avatar client={client} mxc={i.avatarUrl} name={i.name} size={36} />
              <span className="grow">{i.name}</span>
              <span className="nets">{i.networks.slice(0, 2).map((n) => <NetBadge key={n} net={n} />)}</span>
            </button></li>
          ))}
        </ul>
        <button className="text-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
