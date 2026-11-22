import { idbSet, idbDel } from './idb.js'

// Notifications while the app is closed: Web Push through the server's push
// gateway (Sygnal). The server advertises its push key in .well-known.
const FLAG = 'inbox.push'
const WK_KEY = 'fit.simas.inbox.push'

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'

let wkCache = null
export async function pushConfig(client) {
  if (wkCache) return wkCache
  try {
    const r = await fetch(`${client.baseUrl}/.well-known/matrix/client`)
    const wk = await r.json()
    wkCache = wk[WK_KEY] || null
  } catch { wkCache = null }
  return wkCache
}

export const pushEnabled = () => { try { return localStorage.getItem(FLAG) === '1' } catch { return false } }

// unsupported | install (iPhone: add to Home Screen first) | unconfigured | denied | off | on
export async function pushState(client) {
  if (isIOS() && !standalone()) return 'install'
  if (!supported()) return 'unsupported'
  if (!(await pushConfig(client))) return 'unconfigured'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted' && pushEnabled()) {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg && (await reg.pushManager.getSubscription())) return 'on'
  }
  return 'off'
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) || navigator.serviceWorker.register('/sw.js')
}

async function registerPusher(client, cfg, sub) {
  const key = sub.getKey ? b64url(sub.getKey('p256dh')) : sub.toJSON().keys.p256dh
  const auth = sub.getKey ? b64url(sub.getKey('auth')) : sub.toJSON().keys.auth
  await client.setPusher({
    kind: 'http',
    app_id: cfg.app_id,
    pushkey: key,
    app_display_name: 'Inbox',
    device_display_name: deviceName(),
    lang: navigator.language || 'en',
    data: { url: cfg.gateway_url, endpoint: sub.endpoint, auth, events_only: true },
  })
  return key
}

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac/.test(ua)) return 'Mac'
  return 'Browser'
}

// Must be called from a tap (iOS only allows the permission prompt then).
export async function enablePush(client) {
  const cfg = await pushConfig(client)
  if (!cfg) throw new Error("This server doesn't have push notifications set up.")
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications were not allowed.')
  const reg = await registration()
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(cfg.vapid_public_key) }))
  await registerPusher(client, cfg, sub)
  // The bridges invite you to a new room for every chat they import; don't notify for those.
  await client.setPushRuleEnabled('override', '.m.rule.invite_for_me', false).catch(() => {})
  try { localStorage.setItem(FLAG, '1') } catch {}
}

export async function disablePush(client) {
  try { localStorage.removeItem(FLAG) } catch {}
  const cfg = await pushConfig(client)
  const reg = await navigator.serviceWorker?.getRegistration()
  const sub = await reg?.pushManager?.getSubscription()
  if (sub && cfg) {
    const key = b64url(sub.getKey('p256dh'))
    await client.setPusher({ kind: null, app_id: cfg.app_id, pushkey: key }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
}

// On every start: if push is on, make sure the server still has our current
// subscription (browsers rotate them now and then).
export async function syncPush(client) {
  if (!pushEnabled() || !supported() || Notification.permission !== 'granted') return
  const cfg = await pushConfig(client)
  if (!cfg) return
  try {
    const reg = await registration()
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(cfg.vapid_public_key) }))
    await registerPusher(client, cfg, sub)
  } catch {}
}

// Clear notifications for rooms you've just read.
export async function closeNotifications(roomIds) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (!reg) return
    for (const n of await reg.getNotifications()) {
      if (roomIds.includes(n.tag) || n.tag === 'inbox-import') n.close()
    }
  } catch {}
}

// The service worker reads the session from IndexedDB (it can't see localStorage).
export function saveSessionForWorker(session) {
  return session ? idbSet('session', { baseUrl: session.baseUrl, accessToken: session.accessToken }) : idbDel('session')
}
