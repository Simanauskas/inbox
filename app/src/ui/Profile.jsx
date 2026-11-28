import React, { useEffect, useState } from 'react'
import { CIRCLES, CIRCLE_LABEL, CRM_EDITS_TYPE, crmFor, profileOf, setField, addTag, removeTag, markFact, addNote, removeNote, keepCard, sinceText } from '../crm.js'
import { requestChange } from './PhoneBook.jsx'

const FIELD_NAME = { org: 'Company', title: 'Job title' }

// The "Profile" part of a contact page: how you know them, how close you are, where they
// work, what you've learned. Suggestions come from the nightly read of your chats; anything
// you set wins, and "why" teaches the next suggestions.
export default function Profile({ ctx, item }) {
  const { client, crm } = ctx
  const entry = crmFor(crm, item)
  const cid = entry?.cid || [...item.rooms].sort()[0]
  const edits = client.accountData[CRM_EDITS_TYPE] || {}
  const p = profileOf(entry ? entry : { cid }, edits)
  const [err, setErr] = useState(null)
  const [askWhy, setAskWhy] = useState(null) // 'circle' | 'strength' after he changes one
  const [why, setWhy] = useState('')
  const [strength, setStrength] = useState(p.strength ?? 50)
  const [tag, setTag] = useState('')
  const [note, setNote] = useState('')
  const [factMenu, setFactMenu] = useState(null)
  useEffect(() => { setStrength(p.strength ?? 50) }, [p.strength])
  const save = (next) => client.setAccountData(CRM_EDITS_TYPE, next).catch((e) => setErr(e.message))
  const set = (field, value, reason) => save(setField(edits, cid, item.name, field, value, reason))
  const first = item.name.split(' ')[0]

  function pickCircle(c) {
    if (c === p.circle && p.mine.circle) return
    set('circle', c)
    if (c !== p.suggested.circle) { setAskWhy('circle'); setWhy('') }
  }
  function commitStrength() {
    if (strength === p.strength && p.mine.strength) return
    set('strength', strength)
    if (p.suggested.strength == null || Math.abs(strength - p.suggested.strength) >= 10) { setAskWhy('strength'); setWhy('') }
  }
  function saveWhy() {
    if (askWhy && why.trim()) set(askWhy, askWhy === 'circle' ? p.circle : strength, why)
    setAskWhy(null)
  }

  const st = p.stats || {}
  const conflicts = p.conflicts
  return (
    <>
      <h3 className="section">How you know {first}</h3>
      <div className="card profile-card">
        {p.summary && <p className="profile-summary">{p.summary}</p>}

        <div className="profile-label">Circle{p.circle && !p.mine.circle && <span className="sugg-mark">suggested</span>}</div>
        <div className="circle-chips">
          {CIRCLES.map((c) => (
            <button key={c} className={`chip ${p.circle === c ? 'on' : ''} ${!p.mine.circle && p.circle === c ? 'suggested' : ''}`} onClick={() => pickCircle(c)} aria-pressed={p.circle === c}>
              {CIRCLE_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="profile-label">Connection strength{p.strength != null && !p.mine.strength && <span className="sugg-mark">suggested</span>}</div>
        <div className="strength-row">
          <input type="range" min="0" max="100" step="5" value={strength} aria-label="Connection strength"
            onChange={(e) => setStrength(+e.target.value)} onPointerUp={commitStrength} onKeyUp={commitStrength} onBlur={commitStrength} />
          <span className="strength-n">{p.strength == null && strength === 50 ? '–' : strength}</span>
        </div>
        {!p.mine.strength && p.reason && <p className="hint small">{p.reason}</p>}
        {(!p.mine.circle || !p.mine.strength) && p.suggested.circle && (
          <button className="text-btn small" onClick={() => {
            let e = edits
            if (!p.mine.circle) e = setField(e, cid, item.name, 'circle', p.suggested.circle)
            if (!p.mine.strength && p.suggested.strength != null) e = setField(e, cid, item.name, 'strength', p.suggested.strength)
            save(e)
          }}>✓ Looks right</button>
        )}
        {askWhy && (
          <div className="why-box">
            <input autoFocus placeholder={`Why? (optional — helps the suggestions learn)`} value={why} onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveWhy() }} enterKeyHint="done" />
            <button className="text-btn" onClick={saveWhy}>{why.trim() ? 'Save' : 'Skip'}</button>
          </div>
        )}

        <div className="profile-label">Tags</div>
        <div className="tag-chips">
          {p.tags.map((t) => <span key={t} className="chip tag-chip">{t}<button aria-label={`Remove ${t}`} onClick={() => save(removeTag(edits, cid, item.name, t))}>×</button></span>)}
          <input className="tag-input" placeholder="+ tag (tennis, school…)" value={tag} onChange={(e) => setTag(e.target.value)} enterKeyHint="done"
            onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) { save(addTag(edits, cid, item.name, tag)); setTag('') } }}
            onBlur={() => { if (tag.trim()) { save(addTag(edits, cid, item.name, tag)); setTag('') } }} />
        </div>

        <div className="profile-grid">
          <Field label="How you met" value={p.met} placeholder="school, work at…, tennis club" onSave={(v) => set('met', v)} />
          <Field label="Since" value={p.since ? String(p.since) : ''} placeholder="year" inputMode="numeric" onSave={(v) => set('since', v ? +v || v : null)} />
          <Field label="Company" value={p.company} placeholder="where they work" onSave={(v) => set('company', v)} />
          <Field label="Role" value={p.role} placeholder="their job" onSave={(v) => set('role', v)} />
          <Field label="Industry" value={p.industry} placeholder="e.g. fintech" onSave={(v) => set('industry', v)} />
        </div>
        {p.pastWork.length > 0 && (
          <p className="hint small">Before: {p.pastWork.map((w) => [w.role, w.company].filter(Boolean).join(', ') + (w.until ? ` (until ${w.until})` : '')).join(' · ')}</p>
        )}
        {st.last && <p className="hint small">Last message {sinceText(st.last)} · {st.m365 || 0} messages this year · {st.total} in all</p>}

        {conflicts.map((c) => (
          <div key={c.field} className="card-conflict">
            <p><b>{FIELD_NAME[c.field] || c.field}</b>: the iCloud card says “{c.card}”, your chats say “{c.learned}”.</p>
            <div className="sugg-actions">
              <button className="text-btn" onClick={() => save(keepCard(edits, cid, item.name, c.field, c.card))}>Keep card</button>
              <button className="primary" onClick={() => requestChange(client, { kind: 'edit', href: entry.href || item.contact?.id, changes: { [c.field]: c.learned } })
                .then(() => save(keepCard(edits, cid, item.name, c.field, c.learned))).catch((e) => setErr(e.message))}>Update card</button>
            </div>
          </div>
        ))}
        {err && <p className="error">{err}</p>}
      </div>

      <h3 className="section">What you know about {first}</h3>
      <ul className="card-list fact-list">
        {p.facts.map((f) => (
          <li key={f.id} className={f.status === 'old' ? 'old' : ''}>
            <button className="fact" onClick={() => setFactMenu(factMenu === f.id ? null : f.id)}>
              <span className="grow">{f.text}{f.status === 'old' && <span className="muted"> · no longer</span>}</span>
              <span className="muted small">{f.ts ? new Date(f.ts).toLocaleDateString() : ''}</span>
            </button>
            {factMenu === f.id && (
              <div className="fact-actions">
                {f.mine ? <button className="text-btn danger" onClick={() => save(removeNote(edits, cid, +String(f.id).slice(5)))}>Remove</button> : <>
                  {f.status === 'old'
                    ? <button className="text-btn" onClick={() => save(markFact(edits, cid, item.name, f, 'current'))}>Still true</button>
                    : <button className="text-btn" onClick={() => save(markFact(edits, cid, item.name, f, 'old'))}>No longer true</button>}
                  <button className="text-btn danger" onClick={() => {
                    const r = window.prompt('Wrong — why? (optional, helps it learn)') ?? null
                    if (r !== null) save(markFact(edits, cid, item.name, f, 'wrong', r))
                  }}>Wrong</button>
                </>}
              </div>
            )}
          </li>
        ))}
        <li><input className="fact-input" placeholder={`Add something about ${first}`} value={note} onChange={(e) => setNote(e.target.value)} enterKeyHint="done"
          onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { save(addNote(edits, cid, item.name, note)); setNote('') } }} /></li>
      </ul>
      {!p.facts.length && <p className="hint">Facts appear here as you talk — every night your chats from that day are read.</p>}
    </>
  )
}

function Field({ label, value, placeholder, onSave, inputMode }) {
  const [v, setV] = useState(value || '')
  useEffect(() => { setV(value || '') }, [value])
  return (
    <label className="profile-field">
      <span>{label}</span>
      <input value={v} placeholder={placeholder} inputMode={inputMode} enterKeyHint="done" onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v.trim() !== (value || '')) onSave(v.trim()) }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    </label>
  )
}
