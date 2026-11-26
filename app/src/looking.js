// Are you looking at Inbox right now? The window is in front and you've used the
// mouse, keyboard or screen in the last minute. (A Mac window stays "visible" behind
// other apps and while you're away from the desk.)
const IDLE_MS = 60_000
let lastInput = Date.now()
const listeners = new Set()
let idleTimer = null

// Phones lock the screen when you stop using them, so there only "in front" counts.
const touchOnly = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches

export function isLooking() {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus() && (touchOnly || Date.now() - lastInput < IDLE_MS)
}

function fire() { for (const fn of listeners) fn() }

function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(fire, IDLE_MS + 50) // tell everyone when you've gone idle
}

let throttle = 0
function input() {
  const was = isLooking()
  lastInput = Date.now()
  armIdle()
  // coming back from idle counts straight away; otherwise at most every few seconds
  if (!was || Date.now() - throttle > 5000) { throttle = Date.now(); fire() }
}

if (typeof window !== 'undefined') {
  for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(t, input, { passive: true, capture: true })
  window.addEventListener('focus', () => { lastInput = Date.now(); armIdle(); fire() })
  window.addEventListener('blur', fire)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { lastInput = Date.now(); armIdle() } fire() })
  armIdle()
}

export function onLookingChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
