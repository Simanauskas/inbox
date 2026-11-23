import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react'
import { Client, PEOPLE_TYPE } from './matrix.js'
import { lockEnabled, unlock, onResume } from './native.js'
import { buildModel, suggestions, previewText, autoMerges, applyAutoMerges } from './people.js'
import { networkInfo } from './networks.js'
import Login from './ui/Login.jsx'
import Inbox from './ui/Inbox.jsx'
import Thread from './ui/Thread.jsx'
import Person from './ui/Person.jsx'
import Merge from './ui/Merge.jsx'
import Settings from './ui/Settings.jsx'
import Search from './ui/Search.jsx'
import { saveSessionForWorker, syncPush, closeNotifications, pushEnabled } from './push.js'
import { idbGet, idbDel, idbSet } from './idb.js'
import { indexContacts } from './contacts.js'
import { Icon } from './ui/common.jsx'

// Your phone book: the server puts it (from BlueBubbles on the Mac) in your
// Matrix media and points to it from account data fit.simas.inbox.contacts.
// Kept on the device so names are right straight away.
export const CONTACTS_TYPE = 'fit.simas.inbox.contacts'
function usePhoneBook(client, url) {
  const [idx, setIdx] = useState(null)
  useEffect(() => {
    let live = true
    idbGet('contacts').then(async (cached) => {
      if (cached?.data && live) { const i = indexContacts(cached.data); client.contactIdx = i; setIdx(i) }
      if (!url || cached?.url === url) return
      try {
        const blobUrl = await client.mediaUrl(url, { download: true })
        const data = await (await fetch(blobUrl)).json()
        await idbSet('contacts', { url, data })
        if (live) { const i = indexContacts(data); client.contactIdx = i; setIdx(i) }
      } catch {}
    })
    return () => { live = false }
  }, [client, url])
  return idx
}

// Open the chat a notification was for (straight into the thread).
function openFromNotification(hash) {
  idbDel('pendingOpen')
  if (location.hash !== hash) location.hash = hash
}

async function consumePendingOpen() {
  const p = await idbGet('pendingOpen')
  if (p && Date.now() - p.at < 2 * 60_000) openFromNotification(p.hash)
  else if (p) idbDel('pendingOpen')
}

const SESSION_KEY = 'inbox.session'

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null }
}

export default function App() {
  const [session, setSession] = useState(loadSession)
  if (!session) {
    return <Login onLogin={(s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch {} setSession(s) }} />
  }
  return (
    <FaceIdLock>
      <Main key={session.accessToken} session={session} onLogout={() => { try { localStorage.removeItem(SESSION_KEY) } catch {} saveSessionForWorker(null); idbDel('contacts'); setSession(null) }} />
    </FaceIdLock>
  )
}

// iPhone app only: when "Lock with Face ID" is on, ask on opening and after Inbox has
// been in the background for over a minute. The app keeps running underneath.
function FaceIdLock({ children }) {
  const [locked, setLocked] = useState(lockEnabled)
  const away = useRef(0)
  const tryUnlock = useCallback(async () => { if (await unlock()) setLocked(false) }, [])
  useEffect(() => { if (locked) tryUnlock() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let off = () => {}
    onResume((active) => {
      if (!lockEnabled()) return
      if (!active) { away.current = Date.now(); return }
      if (away.current && Date.now() - away.current > 60_000) { setLocked(true); tryUnlock() }
    }).then((f) => { off = f })
    return () => off()
  }, [tryUnlock])
  return (
    <>
      {children}
      {locked && (
        <div className="lock-screen">
          <Icon name="lock" size={40} />
          <h2>Inbox is locked</h2>
          <button className="primary" onClick={tryUnlock}>Unlock</button>
        </div>
      )}
    </>
  )
}

function useHashRoute() {
  const parse = () => {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
    const [view, ...rest] = h.split('/')
    return { view: view || 'inbox', arg: rest.join('/') || null }
  }
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const on = () => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}


function Main({ session, onLogout }) {
  const client = useMemo(() => new Client(session), [session])
  const version = useSyncExternalStore(client.subscribe, client.getVersion)
  const route = useHashRoute()
  const [wide, setWide] = useState(() => matchMedia('(min-width: 900px)').matches)

  useEffect(() => {
    const mq = matchMedia('(min-width: 900px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const contactIdx = usePhoneBook(client, client.accountData[CONTACTS_TYPE]?.url)
  const model = useMemo(
    () => buildModel(client.rooms, client.accountData, client.userId, client.accountData[PEOPLE_TYPE], contactIdx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, contactIdx],
  )
  const sugg = useMemo(() => suggestions(model), [model])
  // combine chats that are certainly the same person (same number / same contact card)
  const autoBusy = useRef(false)
  useEffect(() => {
    if (autoBusy.current || !client.synced) return
    const merges = autoMerges(model)
    if (!merges.length) return
    autoBusy.current = true
    client.setAccountData(PEOPLE_TYPE, applyAutoMerges(client.accountData[PEOPLE_TYPE], merges))
      .catch(() => {}).finally(() => { autoBusy.current = false })
  }, [model, client])

  const findItem = useCallback((key) => {
    if (!key) return null
    const exact = model.items.find((i) => i.key === key) || model.connections.find((i) => i.key === key)
    if (exact) return exact
    // a room that has since been merged into a person
    const roomId = key.startsWith('r:') ? key.slice(2) : null
    return roomId ? model.items.find((i) => i.rooms.includes(roomId)) || null : null
  }, [model])

  useEffect(() => {
    client.onLoggedOut = onLogout
    // push: let the service worker see the session, keep the subscription fresh,
    // clear notifications for what you've read, and open the chat a notification was for
    saveSessionForWorker(session)
    syncPush(client)
    client.onRead = (roomId) => closeNotifications([roomId])
    const onSwMessage = (e) => { if (e.data?.type === 'open' && e.data.hash) openFromNotification(e.data.hash) }
    navigator.serviceWorker?.addEventListener('message', onSwMessage)
    // a notification tapped while the app was closed or asleep
    const onVisible = () => { if (document.visibilityState === 'visible') consumePendingOpen() }
    document.addEventListener('visibilitychange', onVisible)
    consumePendingOpen()
    // notifications while the app is open but in the background (push covers it when on)
    client.onMessage = (room, ev) => {
      if (pushEnabled()) return
      if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const m = buildModel(client.rooms, client.accountData, client.userId, client.accountData[PEOPLE_TYPE], client.contactIdx)
      const item = m.items.find((i) => i.rooms.includes(room.id))
      if (!item) return
      const title = `${item.name} · ${networkInfo(m.info[room.id].network).name}`
      navigator.serviceWorker?.getRegistration().then((reg) => {
        const opts = { body: previewText(ev, client.userId), tag: room.id, data: { hash: `#/t/${encodeURIComponent(item.key)}` } }
        if (reg) reg.showNotification(title, opts)
        else new Notification(title, opts)
      })
    }
    client.start()
    return () => {
      client.stop()
      navigator.serviceWorker?.removeEventListener('message', onSwMessage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [client, onLogout, session])

  const totalUnread = model.items.reduce((s, i) => s + i.unread, 0)
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Inbox` : 'Inbox'
    // setAppBadge(undefined) would show an empty badge; clear it when nothing is unread
    const nav = navigator
    const p = totalUnread ? nav.setAppBadge?.(totalUnread) : nav.clearAppBadge?.()
    p?.catch?.(() => {})
  }, [totalUnread])

  // Chats the list doesn't show (bridge bot chats, spaces) still count as unread on the
  // server, which sets the number on notifications and the app icon. Mark them read.
  useEffect(() => {
    if (!client.synced) return
    for (const [id, i] of Object.entries(model.info)) {
      if ((i.kind === 'connection' || i.kind === 'space') && (client.rooms[id]?.notificationCount || 0) > 0) client.markRead(id)
    }
  }, [model, client])

  const ctx = { client, model, sugg, findItem, wide, route, version, onLogout }
  let page = null
  const item = route.arg ? findItem(route.arg) : null
  if (route.view === 't' && item) page = <Thread key={item.key} ctx={ctx} item={item} />
  else if (route.view === 'p' && item) page = <Person key={item.key} ctx={ctx} item={item} />
  else if (route.view === 'merge') page = <Merge ctx={ctx} />
  else if (route.view === 'settings') page = <Settings ctx={ctx} />
  else if (route.view === 'search') page = <Search ctx={ctx} />
  else if ((route.view === 't' || route.view === 'p') && !client.synced) page = <div className="empty-pane"><div className="spinner" /></div>

  if (wide) {
    return (
      <div className="app split">
        <aside className="list-pane"><Inbox ctx={ctx} selected={item?.key} /></aside>
        <main className="detail-pane">{page || <div className="empty-pane"><p>Pick a conversation</p></div>}</main>
      </div>
    )
  }
  return <div className="app">{page || <Inbox ctx={ctx} />}</div>
}
