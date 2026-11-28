import React, { useMemo, useState } from 'react'
import { back, go } from '../router.js'
import { CIRCLES, CIRCLE_PLURAL, CRM_EDITS_TYPE, peopleSections, allTags, drifting, sinceText } from '../crm.js'
import { Avatar, TopBar } from './common.jsx'

// Everyone you know, by circle, closest first; filter by tag (tennis…) or find who works
// where ("bank", "fintech"); "Lost touch" = close people you haven't written to for a while.
export default function PeoplePage({ ctx }) {
  const { client, crm, model } = ctx
  const edits = client.accountData[CRM_EDITS_TYPE] || {}
  const [q, setQ] = useState('')
  const [tag, setTag] = useState(null)
  const [drift, setDrift] = useState(false)
  const sections = useMemo(() => peopleSections(crm, edits, { q, tag, drift }), [crm, edits, q, tag, drift])
  const tags = useMemo(() => allTags(crm, edits).slice(0, 20), [crm, edits])
  const count = sections.reduce((n, s) => n + s.people.length, 0)
  const open = (p) => {
    const it = model.items.find((i) => i.rooms.some((r) => p.rooms.includes(r)))
    if (it) go('p', it.key)
  }
  const avatarOf = (p) => model.items.find((i) => i.rooms.some((r) => p.rooms.includes(r)))?.avatarUrl
  return (
    <div className="page people-page">
      <TopBar onBack={back} title="People" />
      <div className="scroll">
        <input className="search" placeholder="Find: name, company, role, industry…" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
        <div className="chips">
          <button className={`chip ${drift ? 'on' : ''}`} onClick={() => setDrift(!drift)} aria-pressed={drift}>Lost touch</button>
          {tags.map((t) => <button key={t} className={`chip ${tag === t ? 'on' : ''}`} onClick={() => setTag(tag === t ? null : t)} aria-pressed={tag === t}>{t}</button>)}
        </div>
        {!crm && <p className="hint">Nothing learned yet. Profiles fill in every night from that day's chats; you can also set them on any contact page.</p>}
        {crm && !count && <p className="muted center">No one matches.</p>}
        {sections.map((s) => (
          <section key={s.circle}>
            <h3 className="section">{s.circle === 'unsorted' ? 'Not sorted yet' : CIRCLE_PLURAL[s.circle]} <span className="muted">{s.people.length}</span></h3>
            <ul className="card-list">
              {s.people.map((p) => (
                <li key={p.cid}><button className="row person-row" onClick={() => open(p)}>
                  <Avatar client={client} mxc={avatarOf(p)} name={p.name} size={40} />
                  <div className="row-main">
                    <div className="row-top">
                      <span className="row-name">{p.name}</span>
                      {p.strength != null && <span className={`strength-pill ${p.mine.strength ? '' : 'suggested'}`} title={p.mine.strength ? 'Your setting' : 'Suggested'}>{p.strength}</span>}
                    </div>
                    <div className="row-bottom">
                      <span className="row-preview">{[[p.role, p.company].filter(Boolean).join(', '), p.tags.join(' · ')].filter(Boolean).join(' — ') || p.summary}</span>
                    </div>
                    {drifting(p) && <div className="drift">Last message {sinceText(p.stats?.last)}</div>}
                  </div>
                </button></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
