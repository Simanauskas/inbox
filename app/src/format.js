// Text formatting, the way WhatsApp/Telegram write it: *bold*, _italic_, ~strike~,
// `code`, ```block```, "> quote", plus @mentions in groups. Sent as HTML so every bridge
// turns it into its app's formatting. Pure (tested); showing received HTML is in ui/Rich.jsx.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// mentions: [{ name, userId }] chosen in the composer; returns null when there's nothing to format
export function markdownToHtml(text, mentions = []) {
  if (!text) return null
  const keep = []
  const hold = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000` }
  let s = esc(text)
  s = s.replace(/```\n?([\s\S]+?)```/g, (_, c) => hold(`<pre><code>${c.replace(/\n$/, '')}</code></pre>`))
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
  for (const m of mentions) {
    const at = esc('@' + m.name)
    if (s.includes(at)) s = s.split(at).join(hold(`<a href="https://matrix.to/#/${encodeURIComponent(m.userId)}">${esc(m.name)}</a>`))
  }
  const wrap = (ch, tag) => {
    const c = ch.replace(/[*~]/g, '\\$&')
    s = s.replace(new RegExp(`(^|[\\s(])${c}(?=\\S)([^${c}\\n]*?\\S)${c}(?=$|[\\s.,!?:;)])`, 'g'), `$1<${tag}>$2</${tag}>`)
  }
  wrap('*', 'b'); wrap('_', 'i'); wrap('~', 's')
  // "> " lines become a quote
  s = s.split('\n').reduce((acc, line) => {
    const q = /^&gt; ?(.*)$/.exec(line)
    const last = acc[acc.length - 1]
    if (q && last?.q) last.lines.push(q[1])
    else acc.push(q ? { q: true, lines: [q[1]] } : { q: false, lines: [line] })
    return acc
  }, []).map((b) => (b.q ? `<blockquote>${b.lines.join('<br>')}</blockquote>` : b.lines[0])).join('<br>').replace(/<\/blockquote><br>/g, '</blockquote>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i])
  return s === esc(text).replace(/\n/g, '<br>') ? null : s
}

// "@Jo" being typed at the end of the text → "Jo" (for member suggestions), else null
export function mentionQuery(text, caret = text.length) {
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret))
  return m ? m[2] : null
}
