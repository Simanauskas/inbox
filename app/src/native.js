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
