// Reactions: your default bar (Settings → Reactions) and the "+" panel.
export const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export const EMOJI_GRID = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '😉', '😇', '😍', '🥰', '😘', '😋',
  '😜', '🤪', '😎', '🤩', '🥳', '😏', '😌', '😴', '🤤', '🤔', '🤨', '😐', '🙄', '😬', '🤐', '🤭',
  '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱', '🥶', '🥵', '🤢', '😷', '🤗',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👌', '✌️', '🤞', '🫶', '🤝', '🫡', '👀', '👋', '🤙', '☝️',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕', '🔥', '💯', '✨', '🎉', '🥂', '🍻',
  '☕', '🍕', '🍔', '🌮', '🎂', '🎁', '🏆', '🥇', '🎾', '🏃', '🏋️', '🚴', '✅', '❌', '⚠️', '❓',
]

const isEmoji = (g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)

// The emojis in a piece of text (whole emojis, incl. skin tones and ZWJ sequences).
export function splitEmojis(text) {
  if (!text) return []
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
    : [...text]
  return parts.filter(isEmoji)
}

export function quickReactions(config) {
  const list = config?.quickReactions
  return Array.isArray(list) && list.length ? list.slice(0, 8) : DEFAULT_REACTIONS
}

// Telegram only takes reactions from its own set (room_features.allowed_reactions).
// Map your bar onto it (👍 is "👍️" there) and fill the rest from its list.
const bare = (e) => e.replace(/️/g, '')
export function allowedReaction(features, emoji) {
  const allowed = features?.allowed_reactions
  if (!Array.isArray(allowed)) return emoji
  return allowed.find((a) => bare(a) === bare(emoji)) || null
}
export function reactionsFor(features, quick) {
  const allowed = features?.allowed_reactions
  if (!Array.isArray(allowed)) return quick
  const out = quick.map((e) => allowedReaction(features, e)).filter(Boolean)
  for (const a of allowed) { if (out.length >= quick.length) break; if (!out.includes(a)) out.push(a) }
  return out
}
