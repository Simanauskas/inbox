import React, { useEffect, useState } from 'react'
import { isNative, lockEnabled, setLockEnabled, biometryName, unlock, nativePushState, startNativePush, openExternal, pushError } from '../native.js'
import { go, back } from '../router.js'
import { PEOPLE_TYPE } from '../matrix.js'
import { normConfig } from '../people.js'
import { pushState, enablePush, disablePush } from '../push.js'
import { NetBadge, TopBar } from './common.jsx'
import { DEFAULT_REACTIONS, quickReactions, splitEmojis } from '../emoji.js'

// The emojis in your reaction bar (press and hold a message). Synced to all your devices.
function Reactions({ client, cfg }) {
  const current = quickReactions(cfg)
  const [text, setText] = useState(current.join(''))
  const picked = splitEmojis(text).slice(0, 8)
  const changed = picked.join('') !== current.join('')
  const save = (list) => client.setAccountData(PEOPLE_TYPE, { ...cfg, quickReactions: list })
  return (
    <div className="card">
      <input className="reaction-edit" value={text} onChange={(e) => setText(e.target.value)} aria-label="Your reaction emojis" inputMode="text" />
      <p className="hint">Type up to 8 emojis, in the order you want them. Any other emoji is one tap away under ＋.</p>
      <div className="sugg-actions">
        <button className="text-btn" onClick={() => { setText(DEFAULT_REACTIONS.join('')); save(DEFAULT_REACTIONS) }}>Reset</button>
        <button className="primary" disabled={!changed || !picked.length} onClick={() => save(picked)}>Save</button>
      </div>
    </div>
  )
}

function NativeNotifications({ client }) {
  const [state, setState] = useState(null)
  const refresh = () => nativePushState().then(setState)
  useEffect(() => { refresh() }, [])
  if (state === null) return <div className="card"><span className="spinner small" /></div>
  return (
    <div className="card">
      {state === 'on' && !pushError && <p>✓ On. New messages show on your iPhone even when Inbox is closed. You can mute a chat to silence it.</p>}
      {state === 'on' && pushError && <p className="error">Allowed, but Apple didn't register this iPhone: {pushError}</p>}
      {state === 'off' && <>
        <p>Get notified of new messages even when Inbox is closed.</p>
        <button className="wide-btn" onClick={() => startNativePush(client).then(refresh)}>Turn on notifications</button>
      </>}
      {state === 'denied' && <>
        <p>Notifications are off for Inbox. Turn them on in the iPhone's Settings → Inbox → Notifications.</p>
        <button className="wide-btn" onClick={() => openExternal('app-settings:')}>Open Settings</button>
      </>}
    </div>
  )
}

function Notifications({ client }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const refresh = () => pushState(client).then(setState)
  useEffect(() => { refresh() }, [])

  async function run(fn) {
    setBusy(true)
    setErr(null)
    try { await fn(client) } catch (e) { setErr(e.message) }
    setBusy(false)
    refresh()
  }

  if (state === null) return <div className="card"><span className="spinner small" /></div>
  return (
    <div className="card">
      {state === 'on' && <>
        <p>✓ On. You'll be notified of new messages even when Inbox is closed.</p>
        <button className="wide-btn" disabled={busy} onClick={() => run(disablePush)}>Turn off</button>
      </>}
      {state === 'off' && <>
        <p>Get notified of new messages even when Inbox is closed.</p>
        <button className="wide-btn" disabled={busy} onClick={() => run(enablePush)}>{busy ? 'Turning on…' : 'Turn on notifications'}</button>
      </>}
      {state === 'install' && <p>On iPhone, notifications only work for apps on the Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>, open Inbox from there, then come back here.</p>}
      {state === 'denied' && <p>Notifications are blocked for Inbox. Allow them in your phone's or browser's settings, then come back here.</p>}
      {state === 'unconfigured' && <p className="muted">Your server doesn't have push notifications set up yet. Run <code>./setup.sh</code> again on the server to add them.</p>}
      {state === 'unsupported' && <p className="muted">This browser doesn't support push notifications.</p>}
      {err && <p className="error">{err}</p>}
    </div>
  )
}

// bot user names the server setup script gives each bridge
const BRIDGES = [
  { net: 'whatsapp', bot: 'whatsappbot', how: 'Send "login qr", then scan the code in WhatsApp: Settings, Linked devices, Link a device.' },
  { net: 'telegram', bot: 'telegrambot', how: 'Send "login" and follow the steps (phone number, then the code Telegram sends you).' },
  { net: 'facebook', bot: 'facebookbot', how: 'Send "login", then pick a method. Username and password is easiest; the setup guide covers the cookie method.' },
  { net: 'instagram', bot: 'instagrambot', how: 'Send "login" and follow the steps. It asks for cookies from instagram.com; the setup guide shows how.' },
  { net: 'imessage', bot: 'imessagebot', how: 'Works through the BlueBubbles app on your Mac. Once that is set up it connects by itself; open this to check it is connected.' },
]
const WINDOWS = [1, 3, 6, 12, 24, 48, 168]

export default function Settings({ ctx }) {
  const { client, model, onLogout } = ctx
  const cfg = normConfig(client.accountData[PEOPLE_TYPE])
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const server = client.userId.split(':').slice(1).join(':')

  async function openBridge(b) {
    const botId = `@${b.bot}:${server}`
    const existing = model.connections.find((c) => client.rooms[c.rooms[0]]?.members[botId] || client.rooms[c.rooms[0]]?.heroes.includes(botId))
    if (existing) return go('t', existing.key)
    setBusy(b.net)
    setErr(null)
    try {
      const roomId = await client.createDM(botId)
      // wait for the room to show up in sync
      for (let i = 0; i < 40 && !client.rooms[roomId]; i++) await new Promise((r) => setTimeout(r, 250))
      await client.send(roomId, { msgtype: 'm.text', body: 'help' }).catch(() => {})
      go('t', `r:${roomId}`)
    } catch (e) {
      setErr(`Couldn't reach the ${b.net} bridge (${e.message}). Is it running on the server?`)
    } finally { setBusy(null) }
  }

  return (
    <div className="page settings">
      <TopBar onBack={back} title="Settings" />
      <div className="scroll">
        <h3 className="section">Replies</h3>
        <div className="card">
          <label className="setting">
            <span>Reply on the app they last wrote from, if it was within</span>
            <select value={cfg.replyWindowHours} onChange={(e) => client.setAccountData(PEOPLE_TYPE, { ...cfg, replyWindowHours: Number(e.target.value) })}>
              {WINDOWS.map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : h === 168 ? '1 week' : `${h / 24} days`}</option>)}
            </select>
          </label>
          <p className="hint">After that, new messages go to the person's default app.</p>
        </div>

        <h3 className="section">Reactions</h3>
        <Reactions client={client} cfg={cfg} />

        <h3 className="section">Notifications</h3>
        {isNative ? <NativeNotifications client={client} /> : <Notifications client={client} />}

        {isNative && <><h3 className="section">Privacy</h3><LockSetting /></>}

        <h3 className="section">Connected apps</h3>
        <p className="hint">Each app is connected through a bridge bot on your server. Open one and follow its instructions to log in.</p>
        {err && <p className="error">{err}</p>}
        <ul className="card-list">
          {BRIDGES.map((b) => (
            <li key={b.net} className="channel-row">
              <NetBadge net={b.net} label />
              <span className="grow muted small">{b.how}</span>
              <button className="pill" disabled={busy === b.net} onClick={() => openBridge(b)}>{busy === b.net ? '…' : 'Open'}</button>
            </li>
          ))}
        </ul>
        {model.connections.length > 0 && <>
          <h3 className="section">Bridge chats</h3>
          <ul className="card-list">
            {model.connections.map((c) => (
              <li key={c.key}><button className="row" onClick={() => go('t', c.key)}><span className="grow">{c.name}</span></button></li>
            ))}
          </ul>
        </>}

        <h3 className="section">Account</h3>
        <div className="card">
          <p>Signed in as <b>{client.userId}</b></p>
          <p className="muted small">{client.baseUrl}</p>
          <button className="wide-btn danger" onClick={async () => { await disablePush(client).catch(() => {}); await client.logout(); onLogout() }}>Sign out</button>
        </div>
      </div>
    </div>
  )
}

// iPhone app: lock Inbox with Face ID (or the passcode)
function LockSetting() {
  const [on, setOn] = useState(lockEnabled)
  const [kind, setKind] = useState(null)
  useEffect(() => { biometryName().then(setKind).catch(() => setKind(null)) }, [])
  if (!kind) return <p className="hint">Set up Face ID or a passcode on this iPhone to lock Inbox.</p>
  async function toggle() {
    if (!on && !(await unlock())) return // prove it works before turning it on
    setLockEnabled(!on)
    setOn(!on)
  }
  return (
    <div className="card">
      <label className="radio">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span>Lock with {kind}</span>
      </label>
      <p className="muted small">Asks when you open Inbox and after it's been in the background for a minute.</p>
    </div>
  )
}
