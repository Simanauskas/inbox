// Bits that only exist in the iPhone app (Capacitor). In the browser these are no-ops
// and the web versions (file inputs, web push) are used instead.
import { Capacitor } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()

// The iPhone photo library, straight away (no Photo Library / Take Photo / Choose Files
// menu): photos and videos, several at once. Returns File objects, [] if cancelled.
export async function pickPhotos() {
  const { FilePicker } = await import('@capawesome/capacitor-file-picker')
  let res
  try {
    res = await FilePicker.pickMedia({ limit: 0, readData: false })
  } catch (e) {
    if (/cancel/i.test(e?.message || '')) return []
    throw e
  }
  return Promise.all((res.files || []).map(async (f) => {
    const blob = await (await fetch(Capacitor.convertFileSrc(f.path))).blob()
    return new File([blob], f.name || 'photo', { type: f.mimeType || blob.type })
  }))
}

// --- Face ID lock ---
const LOCK_KEY = 'inbox.faceIdLock'
export const lockEnabled = () => { try { return isNative && localStorage.getItem(LOCK_KEY) === '1' } catch { return false } }
export const setLockEnabled = (on) => { try { on ? localStorage.setItem(LOCK_KEY, '1') : localStorage.removeItem(LOCK_KEY) } catch {} }

export async function biometryName() {
  if (!isNative) return null
  const { BiometricAuth, BiometryType } = await import('@aparajita/capacitor-biometric-auth')
  const r = await BiometricAuth.checkBiometry()
  if (!r.isAvailable && !r.deviceIsSecure) return null
  return r.biometryType === BiometryType.touchId ? 'Touch ID' : r.biometryType === BiometryType.faceId ? 'Face ID' : 'passcode'
}

// true when unlocked (Face ID, or the iPhone passcode as a fallback)
export async function unlock() {
  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
  try {
    await BiometricAuth.authenticate({ reason: 'Unlock Inbox', allowDeviceCredential: true, iosFallbackTitle: 'Use passcode' })
    return true
  } catch {
    return false
  }
}

// called when the app comes back from the background
export async function onResume(fn) {
  if (!isNative) return () => {}
  const { App } = await import('@capacitor/app')
  const h = await App.addListener('appStateChange', ({ isActive }) => fn(isActive))
  return () => h.remove()
}

// Hand a link to iOS (WhatsApp, FaceTime, phone, Messenger). Inside the app a plain
// location change would try to load it in the app's own web view and do nothing.
export async function openExternal(url) {
  if (!isNative) { window.location.href = url; return }
  const { AppLauncher } = await import('@capacitor/app-launcher')
  await AppLauncher.openUrl({ url })
}

// App start: no "form" bar (up / down / ✓) above the keyboard. The app itself shrinks to
// sit above the keyboard (capacitor.config.json Keyboard.resize = native), so the header
// with the contact stays in view.
export async function initNative() {
  if (!isNative) return
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    await Keyboard.setAccessoryBarVisible({ isVisible: false })
    // while the keyboard is up there's no home bar to leave room for
    // The app keeps its full size behind the keyboard (resizing the native view lagged and
    // showed black around the keyboard); the layout just leaves room for it.
    const root = document.documentElement
    Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => { root.style.setProperty('--kb', `${keyboardHeight}px`); root.classList.add('kb-open') })
    Keyboard.addListener('keyboardWillHide', () => { root.style.setProperty('--kb', '0px'); root.classList.remove('kb-open') })
  } catch {}
}

// iPhone app: open Apple Calendar's own "New Event" screen, filled in, with the calendar
// preselected (his "Simanauskas | Personal"; Settings can't pick one yet). Reading the
// calendar list needs calendar access once. Returns false if it couldn't open.
export const CALENDAR_NAME = 'Simanauskas | Personal'
export async function addToAppleCalendar({ title, start, end, place, notes }) {
  if (!isNative) return false
  const { CapacitorCalendar } = await import('@ebarooni/capacitor-calendar')
  let calendarId
  try {
    const p = await CapacitorCalendar.requestFullCalendarAccess()
    if (p.result === 'granted') {
      const { result } = await CapacitorCalendar.listCalendars()
      const want = CALENDAR_NAME.toLowerCase()
      const label = (c) => `${c.source?.title || c.accountName || ''} | ${c.title || ''}`.toLowerCase()
      const hit = result.find((c) => (c.title || '').toLowerCase() === want) || result.find((c) => label(c) === want)
        || result.find((c) => (c.title || '').toLowerCase() === 'personal' && label(c).includes('simanauskas'))
      calendarId = hit?.id
    }
  } catch {}
  await CapacitorCalendar.createEventWithPrompt({
    title, startDate: start.getTime(), endDate: end.getTime(), location: place || undefined, description: notes || undefined,
    ...(calendarId ? { calendarId } : {}),
  })
  return true
}

// --- Notifications (Apple push) ---
// The iPhone gives the app a device token; the server (Sygnal) sends notifications to it
// through Apple. Pusher app id must match the "fit.simas.inbox.ios" app in sygnal.yaml.
export const IOS_PUSH_APP_ID = 'fit.simas.inbox.ios'
const GATEWAY_URL = 'http://sygnal:5000/_matrix/push/v1/notify'
const hexToB64 = (hex) => btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))))

// 'on' | 'off' (not asked yet) | 'denied' | null (not the iPhone app)
export async function nativePushState() {
  if (!isNative) return null
  const { PushNotifications } = await import('@capacitor/push-notifications')
  const { receive } = await PushNotifications.checkPermissions()
  return receive === 'granted' ? 'on' : receive === 'denied' ? 'denied' : 'off'
}

let pushStarted = false
export let pushError = null // why Apple refused to register, if it did
// Ask once (iOS shows its own prompt), then register with Apple on every start so the
// server always has the current token. Tapping a notification opens that chat.
export async function startNativePush(client, { ask = true, onOpen } = {}) {
  if (!isNative) return
  const { PushNotifications } = await import('@capacitor/push-notifications')
  if (!pushStarted) {
    pushStarted = true
    PushNotifications.addListener('registration', async ({ value }) => {
      const pushkey = hexToB64(value)
      try {
        await client.setPusher({
          kind: 'http', app_id: IOS_PUSH_APP_ID, pushkey, app_display_name: 'Inbox', device_display_name: 'iPhone app',
          lang: navigator.language || 'en', data: { url: GATEWAY_URL },
        })
        // the Home Screen web app on this phone would notify a second time
        const { pushers = [] } = await client.api('GET', '/_matrix/client/v3/pushers')
        for (const p of pushers) {
          if (p.app_id !== IOS_PUSH_APP_ID && p.device_display_name === 'iPhone') {
            await client.setPusher({ kind: null, app_id: p.app_id, pushkey: p.pushkey }).catch(() => {})
          }
        }
        // the bridges invite you to a new room for every chat they import; don't notify for those
        await client.setPushRuleEnabled('override', '.m.rule.invite_for_me', false).catch(() => {})
      } catch {}
    })
    PushNotifications.addListener('registrationError', ({ error }) => { pushError = String(error || 'unknown error') })
    PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const roomId = notification?.data?.room_id
      if (roomId) onOpen?.(`#/t/${encodeURIComponent('r:' + roomId)}`)
    })
  }
  let { receive } = await PushNotifications.checkPermissions()
  if (receive !== 'granted' && receive !== 'denied' && ask) receive = (await PushNotifications.requestPermissions()).receive
  if (receive === 'granted') await PushNotifications.register()
  return receive
}

// Clear a chat's notifications from the lock screen once you've read it.
export async function clearNativeNotifications(roomIds) {
  if (!isNative) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const { notifications } = await PushNotifications.getDeliveredNotifications()
    const gone = notifications.filter((n) => roomIds.includes(n.data?.room_id))
    if (gone.length) await PushNotifications.removeDeliveredNotifications({ notifications: gone })
  } catch {}
}

// Touch screens: tap anywhere outside a text field to put the keyboard away (there's no
// "Done" button above it). Not inside the chat's message box area, where buttons like
// send must keep the keyboard up.
export function tapToDismissKeyboard() {
  if (typeof window === 'undefined' || !matchMedia('(pointer: coarse)').matches) return () => {}
  const field = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  const on = (e) => {
    const a = document.activeElement
    if (!field(a)) return
    const t = e.target
    if (field(t) || t.closest?.('label, .composer, .mention-list, .attach-menu, .sheet')) return
    a.blur()
  }
  document.addEventListener('touchstart', on, { capture: true, passive: true })
  return () => document.removeEventListener('touchstart', on, { capture: true })
}
