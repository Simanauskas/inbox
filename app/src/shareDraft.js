// Photos/text shared in from another app, waiting for a chat's message box to pick them up.
const drafts = new Map()
const listeners = new Set()
export function setSharedDraft(key, draft) { drafts.set(key, draft); for (const fn of listeners) fn(key) }
export function takeSharedDraft(key) { const d = drafts.get(key); drafts.delete(key); return d || null }
export function onSharedDraft(fn) { listeners.add(fn); return () => listeners.delete(fn) }
