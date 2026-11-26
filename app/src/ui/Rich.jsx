import React from 'react'

// Formatted messages (bold, italic, lists, quotes, code, mentions) as the bridges send them
// (formatted_body HTML). Only a small, safe set of tags is kept; everything else becomes text.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'S', 'DEL', 'STRIKE', 'U', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'BR', 'P', 'A', 'H1', 'H2', 'H3', 'H4', 'SPAN'])

function clean(node, doc, members) {
  const out = doc.createDocumentFragment()
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) { out.appendChild(doc.createTextNode(child.textContent)); continue }
    if (child.nodeType !== 1) continue
    const tag = child.tagName
    if (tag === 'MX-REPLY' || tag === 'SCRIPT' || tag === 'STYLE') continue // reply quote is shown separately; never scripts
    if (!ALLOWED.has(tag)) { out.appendChild(clean(child, doc, members)); continue }
    const el = doc.createElement(/^H\d$/.test(tag) ? 'B' : tag)
    if (tag === 'A') {
      const href = child.getAttribute('href') || ''
      const user = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/.exec(href)
      if (user) {
        // a mention: show the person's name
        const uid = decodeURIComponent(user[1])
        const span = doc.createElement('span')
        span.className = 'mention'
        span.textContent = '@' + (members?.[uid]?.displayname?.replace(/\s*\((WA|FB|IG|TG)\)$/, '') || child.textContent.replace(/^@/, ''))
        out.appendChild(span)
        continue
      }
      if (!/^https?:\/\//i.test(href)) { out.appendChild(clean(child, doc, members)); continue }
      el.setAttribute('href', href)
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noreferrer noopener')
    }
    if (tag === 'OL' && /^\d+$/.test(child.getAttribute('start') || '')) el.setAttribute('start', child.getAttribute('start'))
    el.appendChild(clean(child, doc, members))
    out.appendChild(el)
  }
  return out
}

export function sanitizeHtml(html, members) {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const box = doc.createElement('div')
  box.appendChild(clean(doc.body, doc, members))
  return box.innerHTML
}

export function hasRichFormatting(c) {
  return c?.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string' && /<(b|strong|i|em|s|del|strike|code|pre|blockquote|ul|ol|a|h\d)\b/i.test(c.formatted_body)
}

export default function Rich({ html, members }) {
  const safe = sanitizeHtml(html, members)
  if (safe == null) return null
  return <span className="text rich" dangerouslySetInnerHTML={{ __html: safe }} />
}
