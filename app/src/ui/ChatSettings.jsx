import React, { useEffect, useRef, useState } from 'react'
import { go } from '../router.js'
import { networkInfo } from '../networks.js'
import { canDo } from '../group.js'
import { Icon } from './common.jsx'

const days = (ms) => {
  const d = Math.round(ms / 86400000)
  return d === 1 ? '24 hours' : d % 365 === 0 ? `${d / 365} year${d > 365 ? 's' : ''}` : d % 30 === 0 && d >= 30 ? `${d / 30} months` : d % 7 === 0 ? `${d / 7} week${d > 7 ? 's' : ''}` : `${d} days`
}

// What the app allows for one chat (from the bridge's room_features): disappearing
// messages, block, delete the chat, group photo. Shown on the contact and group pages.
export default function ChatSettings({ client, model, roomId, kind, name }) {
  const room = client.rooms[roomId]
  useEffect(() => { client.loadFeatures(roomId) }, [roomId])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const photo = useRef(null)
  const f = room?.features
  if (!room || !f) return null
  const app = networkInfo(model.info[roomId]?.network).name
  const timers = f.disappearing_timer?.timers || []
  const canTimer = timers.length > 0 && (kind !== 'group' || canDo(room, client.userId, 'com.beeper.disappearing_timer'))
  const blocked = !!room.bridge?.channel?.['com.beeper.user_blocked']
  const canPhoto = kind === 'group' && f.state?.['m.room.avatar']?.level > 0 && canDo(room, client.userId, 'm.room.avatar')
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn() } catch (e) { setErr(e.message) } setBusy(false) }
  if (!canTimer && !f.block_user && !f.delete_chat && !canPhoto) return null

  return (
    <div className="card chat-settings">
      {canTimer && (
        <label className="setting-row">
          <Icon name="timer" size={18} />
          <span className="grow">Disappearing messages</span>
          <select value={room.disappearing?.timer || 0} disabled={busy} onChange={(e) => run(() => client.setDisappearing(roomId, +e.target.value))}>
            <option value={0}>Off</option>
            {timers.map((t) => <option key={t} value={t}>{days(t)}</option>)}
          </select>
        </label>
      )}
      {canPhoto && (
        <button className="setting-row" disabled={busy} onClick={() => photo.current?.click()}>
          <Icon name="camera" size={18} /><span className="grow">Change group photo</span>
          <input ref={photo} type="file" accept="image/*" hidden onChange={(e) => { const file = e.target.files[0]; e.target.value = ''; if (file) run(() => client.setRoomAvatar(roomId, file)) }} />
        </button>
      )}
      {f.block_user && kind !== 'group' && (
        <button className="setting-row danger" disabled={busy}
          onClick={() => (blocked || confirm(`Block ${name} on ${app}? They won't be able to message or call you there.`)) && run(() => client.blockUser(roomId, !blocked))}>
          <Icon name="block" size={18} /><span className="grow">{blocked ? `Unblock ${name} on ${app}` : `Block ${name} on ${app}`}</span>
        </button>
      )}
      {f.delete_chat && (
        <button className="setting-row danger" disabled={busy}
          onClick={() => confirm(`Delete this chat on ${app}? Its messages are removed from ${app} on your phone too.`) && run(async () => { await client.deleteChat(roomId); go('inbox') })}>
          <Icon name="trash" size={18} /><span className="grow">Delete chat on {app}</span>
        </button>
      )}
      {f.delete_chat_for_everyone && (
        <button className="setting-row danger" disabled={busy}
          onClick={() => confirm(`Delete this chat for both of you on ${app}? This can't be undone.`) && run(async () => { await client.deleteChat(roomId, { forEveryone: true }); go('inbox') })}>
          <Icon name="trash" size={18} /><span className="grow">Delete for both of you</span>
        </button>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  )
}
