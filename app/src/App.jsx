import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react'
import { Client, PEOPLE_TYPE } from './matrix.js'
import { lockEnabled, unlock, onResume, isNative, startNativePush, clearNativeNotifications, tapToDismissKeyboard } from './native.js'
import { buildModel, suggestions, previewText, autoMerges, applyAutoMerges } from './people.js'
import { networkInfo } from './networks.js'
import Login from './ui/Login.jsx'
import Inbox from './ui/Inbox.jsx'
import Thread from './ui/Thread.jsx'
import Person from './ui/Person.jsx'
import Merge from './ui/Merge.jsx'
import Settings, { claudeTrouble } from './ui/Settings.jsx'
import Search from './ui/Search.jsx'
import { ListsPage, ListPage } from './ui/Lists.jsx'
import { saveSessionForWorker, syncPush, closeNotifications, pushEnabled } from './push.js'
import { idbGet, idbDel, idbSet } from './idb.js'
import { indexContacts } from './contacts.js'
import { Icon } from './ui/common.jsx'
import { back, go } from './router.js'

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
  useEdgeSwipeBack(!!route.view && route.view !== 'inbox' && !wide)
  useEffect(() => tapToDismissKeyboard(), [])
  const updateReady = useUpdateCheck()

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
    client.onRead = (roomId) => { closeNotifications([roomId]); clearNativeNotifications([roomId]) }
    // iPhone app: notifications through Apple (asks once), tap one to open the chat
    startNativePush(client, { onOpen: openFromNotification }).catch(() => {})
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

  // archived chats don't count (like WhatsApp); their unread shows on the Archived row
  const totalUnread = model.items.reduce((s, i) => s + (i.archived ? 0 : i.unread), 0)
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
    // Archived chats don't count either (like WhatsApp): mark them read so the phone's badge,
    // which the server counts, matches. Something new brings the chat back as unread.
    for (const it of model.items) {
      if (!it.archived) continue
      for (const id of it.rooms) if ((client.rooms[id]?.notificationCount || 0) > 0) client.markRead(id)
    }
  }, [model, client])
  // reactions: notify only for reactions to your messages (unless a chat asks for all)
  useEffect(() => { if (client.synced) client.ensureReactionRule() }, [client, client.synced])

  const ctx = { client, model, sugg, findItem, wide, route, version, onLogout }
  let page = null
  const item = route.arg ? findItem(route.arg) : null
  if (route.view === 't' && item) page = <Thread key={item.key} ctx={ctx} item={item} />
  else if (route.view === 'p' && item) page = <Person key={item.key} ctx={ctx} item={item} />
  else if (route.view === 'merge') page = <Merge ctx={ctx} />
  else if (route.view === 'settings') page = <Settings ctx={ctx} />
  else if (route.view === 'search') page = <Search ctx={ctx} />
  else if (route.view === 'lists') page = <ListsPage ctx={ctx} />
  else if (route.view === 'list' && route.arg) page = <ListPage key={route.arg} ctx={ctx} id={route.arg} />
  else if ((route.view === 't' || route.view === 'p') && !client.synced) page = <div className="empty-pane"><div className="spinner" /></div>

  const trouble = claudeTrouble(client)
  const updateBar = updateReady ? <button className="update-bar" onClick={() => location.reload()}>A new version of Inbox is ready. <b>Update</b></button>
    : trouble === 'expired' && route.view !== 'settings' ? <button className="update-bar" onClick={() => go('settings')}>Reply suggestions: the Claude sign-in needs renewing. <b>How</b></button>
    : null
  if (wide) {
    return (
      <div className="app split">
        {updateBar}
        <aside className="list-pane"><Inbox ctx={ctx} selected={item?.key} /></aside>
        <main className="detail-pane">{page || <div className="empty-pane"><p>Pick a conversation</p></div>}</main>
      </div>
    )
  }
  // On the phone the inbox stays drawn underneath and pages slide in over it, so swiping
  // back shows the inbox following your finger (not a black screen) and keeps its scroll.
  return (
    <div className="app">
      {updateBar}
      <div className="base-layer" inert={page ? '' : undefined} aria-hidden={!!page}><Inbox ctx={ctx} /></div>
      {page && <div className="page-layer">{page}</div>}
    </div>
  )
}

// Swipe in from the left edge to go back, like native iPhone apps (the Home Screen
// version and the iPhone app don't get Safari's own gesture). The page follows your
// finger; let go past a third of the screen (or with a quick flick) to go back.
function useEdgeSwipeBack(enabled) {
  useEffect(() => {
    if (!enabled) return
    let start = null
    let page = null
    const reset = (animate) => {
      if (!page) return
      page.style.transition = animate ? 'transform 0.2s ease-out' : ''
      page.style.transform = ''
      const p = page
      setTimeout(() => { p.style.transition = '' }, 220)
    }
    const onStart = (e) => {
      const t = e.touches[0]
      if (e.touches.length !== 1 || t.clientX > 24) return
      start = { x: t.clientX, y: t.clientY, t: Date.now(), dragging: false }
      page = document.querySelector('.page-layer')
      if (!page) { start = null; return }
      document.body.classList.add('swiping')
      // only now listen to finger moves in a way that can stop scrolling; a permanent
      // non-passive listener made every scroll in the app wait for JavaScript
      document.addEventListener('touchmove', onMove, { passive: false })
    }
    const onMove = (e) => {
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (!start.dragging) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > dx) { start = null; document.removeEventListener('touchmove', onMove); return } // a scroll, not a swipe
        if (dx < 10) return
        start.dragging = true
      }
      e.preventDefault()
      if (page) page.style.transform = `translateX(${Math.max(0, dx)}px)`
    }
    const onEnd = (e) => {
      document.removeEventListener('touchmove', onMove)
      document.body.classList.remove('swiping')
      if (!start) return
      const dx = (e.changedTouches[0]?.clientX || 0) - start.x
      const fast = dx > 60 && Date.now() - start.t < 250
      const was = start.dragging
      start = null
      if (was && (dx > window.innerWidth / 3 || fast)) {
        if (page) { page.style.transition = 'transform 0.15s ease-out'; page.style.transform = `translateX(${window.innerWidth}px)` }
        setTimeout(() => { reset(false); back() }, 150)
      } else reset(true)
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled])
}

// The web app (Mac Dock / Home Screen) can stay open for days without reloading, so it
// would keep running an old version. Look for a newer build when the app comes back into
// view (at most every 10 minutes) and offer a one-tap reload. (The iPhone app updates
// through TestFlight instead.)
function useUpdateCheck() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (isNative || !import.meta.env.PROD) return
    const mine = () => [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-[^/]+\.js$/.test(s))
    let last = 0
    const check = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 600_000) return
      last = Date.now()
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text()
        const latest = /\/assets\/index-[^"']+\.js/.exec(html)?.[0]
        const current = mine()
        if (latest && current && !current.endsWith(latest)) setReady(true)
      } catch {}
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [])
  return ready
}
