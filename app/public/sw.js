// Service worker: app-shell cache (so the inbox opens instantly and offline)
// and push notifications while the app is closed. Matrix traffic is on another
// origin and is never cached here.
importScripts('/push-notify.js')

const CACHE = 'inbox-v2'
const OLD_MESSAGE_MS = 15 * 60 * 1000

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put('/', c)); return r }).catch(() => caches.match('/')))
    return
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); return r })))
  }
})

// --- push ---

self.addEventListener('push', (e) => {
  let p = {}
  try { p = e.data ? e.data.json() : {} } catch {}
  e.waitUntil(handlePush(p))
})

async function handlePush(p) {
  // While Inbox is open (e.g. the Mac Dock app), the app keeps the badge itself from what
  // the list shows; the server's number also counts hidden chats (archived, bot chats).
  const open = (await self.clients.matchAll({ type: 'window' })).length > 0
  if (!open && typeof p.unread === 'number' && self.navigator.setAppBadge) {
    await (p.unread ? self.navigator.setAppBadge(p.unread) : self.navigator.clearAppBadge()).catch(() => {})
  }
  // Bridges import old history as if it were new. Fold anything older than a
  // few minutes into one silent notification instead of buzzing for each.
  // (Browsers require a visible notification for every push, so it can't be dropped.)
  const age = await eventAge(p)
  if (age !== null && age > OLD_MESSAGE_MS) {
    return self.registration.showNotification('Inbox', {
      body: 'Importing older messages…', tag: 'inbox-import', silent: true, icon: '/icon-192.png', data: { hash: '' },
    })
  }
  const n = self.InboxPush.notificationFromPush(p)
  // You're reading this chat in Inbox on this device right now: nothing to show here.
  // (Browsers want a notification for every push, so show it silently and close it.)
  if (p.room_id && await readingHere(p.room_id)) {
    await self.registration.showNotification(n.title, { ...n.options, silent: true, renotify: false, tag: 'inbox-reading' })
    for (const x of await self.registration.getNotifications({ tag: 'inbox-reading' })) x.close()
    return
  }
  return self.registration.showNotification(n.title, n.options)
}

async function readingHere(roomId) {
  const q = await idbGet('quietRooms')
  if (!q || !q.rooms || !q.rooms.includes(roomId) || Date.now() - q.at > 90_000) return false
  const cs = await self.clients.matchAll({ type: 'window' })
  return cs.some((c) => c.focused && c.visibilityState === 'visible')
}

// How old the event is, using the session the app saved for us; null if unknown.
async function eventAge(p) {
  if (!p.room_id || !p.event_id) return null
  try {
    const s = await idbGet('session')
    if (!s) return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const r = await fetch(`${s.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(p.room_id)}/event/${encodeURIComponent(p.event_id)}`, {
      headers: { Authorization: `Bearer ${s.accessToken}` }, signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) return null
    const ev = await r.json()
    return ev.origin_server_ts ? Date.now() - ev.origin_server_ts : null
  } catch { return null }
}

function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('inbox', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onerror = () => resolve(null)
    req.onsuccess = () => {
      try {
        const get = req.result.transaction('kv').objectStore('kv').get(key)
        get.onsuccess = () => resolve(get.result || null)
        get.onerror = () => resolve(null)
      } catch { resolve(null) }
    }
  })
}

function idbSet(key, value) {
  return new Promise((resolve) => {
    const req = indexedDB.open('inbox', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onerror = () => resolve()
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(value, key)
        tx.oncomplete = tx.onerror = () => resolve()
      } catch { resolve() }
    }
  })
}

// Tapping a notification opens that chat. The chat to open is also written to
// IndexedDB first: iOS may start the home-screen app without the link's #hash,
// and the app picks the note up when it starts or comes to the front.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const hash = e.notification.data?.hash || ''
  e.waitUntil((async () => {
    if (hash) await idbSet('pendingOpen', { hash, at: Date.now() })
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const c = cs[0]
    if (c) {
      c.postMessage({ type: 'open', hash })
      return c.focus()
    }
    return self.clients.openWindow('/' + hash)
  })())
})
