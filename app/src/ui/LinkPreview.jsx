import React, { useEffect, useRef, useState } from 'react'
import { useMedia } from './common.jsx'

import { urlsIn, hostOf, attachedPreview, usefulPreview } from '../links.js'
export { urlsIn, hostOf }

const asked = new Map() // url → Promise<preview|null>, for this app session
function askServer(client, url) {
  if (!asked.has(url)) {
    asked.set(url, client.api('GET', '/_matrix/client/v1/media/preview_url', null, { query: { url } }).catch(() => null))
  }
  return asked.get(url)
}

// The bridge's preview if there is one, otherwise ask our server (Synapse fetches the page
// and its picture, YouTube through oEmbed) once the card scrolls into view.
export function usePreview(client, content, url, ref) {
  const given = attachedPreview(content, url)
  const [p, setP] = useState(given)
  useEffect(() => {
    if (given || !url) return
    let live = true
    const load = () => askServer(client, url).then((r) => live && setP(r))
    const el = ref?.current
    if (!el || typeof IntersectionObserver === 'undefined') { load(); return () => { live = false } }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load() } }, { rootMargin: '300px' })
    io.observe(el)
    return () => { live = false; io.disconnect() }
  }, [url, !!given])
  return given || p
}

// WhatsApp-style link card: picture, title, a line of description, the site.
export function LinkCard({ client, content, url, compact }) {
  const ref = useRef(null)
  const p = usePreview(client, content, url, ref)
  const img = useMedia(client, p?.['og:image'], compact ? 120 : 480)
  const ok = usefulPreview(p, url)
  if (!ok) return <span ref={ref} className="link-card-probe" />
  const title = p['og:title'] || hostOf(url)
  const desc = p['og:description'] && p['og:description'] !== title ? p['og:description'] : ''
  const wide = !compact && img && (p['og:image:width'] || 0) >= 400
  return (
    <a ref={ref} className={`link-card ${compact ? 'compact' : ''} ${wide ? 'wide' : ''}`} href={url} target="_blank" rel="noreferrer"
      onClick={(e) => e.stopPropagation()}>
      {img && <img className="link-card-img" src={img} alt="" />}
      <span className="link-card-text">
        <span className="link-card-title">{title}</span>
        {desc && <span className="link-card-desc">{desc}</span>}
        <span className="link-card-host">{hostOf(p['og:url'] || url)}</span>
      </span>
    </a>
  )
}
