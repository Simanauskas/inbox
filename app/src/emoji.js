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
