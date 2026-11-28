// Pure helpers for link previews (tested in links.test.js).
const URL_RE = /https?:\/\/[^\s<>"]+/g

// Links in a message, without trailing punctuation ("see https://x.lt/a)." → https://x.lt/a).
export function urlsIn(text) {
  return ((text || '').match(URL_RE) || []).map((u) => u.replace(/[).,!?;:'"»]+$/, ''))
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

// The preview the bridge already attached to the message (WhatsApp, Telegram, Messenger…
// send one as com.beeper.linkpreviews), for this link or the message's only link.
export function attachedPreview(content, url) {
  const all = content?.['com.beeper.linkpreviews'] || []
  return all.find((p) => p.matched_url === url || p['og:url'] === url) || (all.length === 1 ? all[0] : null)
}

// A preview worth showing: has a picture, or a real title/description (not just the domain).
export function usefulPreview(p, url) {
  if (!p) return false
  const host = hostOf(url)
  const title = (p['og:title'] || '').trim()
  return !!(p['og:image'] || (title && title !== host && title !== url) || p['og:description'])
}

