import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToHtml, mentionQuery } from './format.js'
import { reactionsFor, allowedReaction } from './emoji.js'
import { pollOf, tallyPoll, mergedTimeline, previewText, canDelete, isDisplayable } from './people.js'

test('formatting like WhatsApp: *bold* _italic_ ~strike~ `code` and quotes', () => {
  assert.equal(markdownToHtml('just text'), null)
  assert.equal(markdownToHtml('a *big* deal'), 'a <b>big</b> deal')
  assert.equal(markdownToHtml('_labai_ ~ne~'), '<i>labai</i> <s>ne</s>')
  assert.equal(markdownToHtml('2*3*4'), null) // not formatting inside words
  assert.equal(markdownToHtml('use `npm i` now'), 'use <code>npm i</code> now')
  assert.equal(markdownToHtml('> quoted\nreply'), '<blockquote>quoted</blockquote>reply')
  assert.equal(markdownToHtml('x <b>y</b> *z*'), 'x &lt;b&gt;y&lt;/b&gt; <b>z</b>')
  assert.equal(markdownToHtml('hi @Jonas K!', [{ name: 'Jonas K', userId: '@whatsapp_1:x' }]), 'hi <a href="https://matrix.to/#/%40whatsapp_1%3Ax">Jonas K</a>!')
  assert.equal(mentionQuery('labas @Jo'), 'Jo')
  assert.equal(mentionQuery('mail a@b'), null)
})

test('Telegram reactions: your bar mapped onto its allowed set', () => {
  const tg = { allowed_reactions: ['❤️', '👍️', '🔥', '🙏', '😢'] }
  assert.deepEqual(reactionsFor(tg, ['👍', '❤️', '😂', '😮', '😢', '🙏']), ['👍️', '❤️', '😢', '🙏', '🔥'])
  assert.equal(allowedReaction(tg, '😂'), null)
  assert.equal(allowedReaction({}, '😂'), '😂')
})

test('polls: question, answers, latest vote per person', () => {
  const start = { event_id: '$p', type: 'org.matrix.msc3381.poll.start', sender: '@whatsapp_1:x', origin_server_ts: 1, content: {
    body: 'Kada?', 'org.matrix.msc3381.poll.start': { max_selections: 1, question: { 'org.matrix.msc1767.text': 'Kada žaidžiam?' },
      answers: [{ id: 'a', 'org.matrix.msc1767.text': 'Šeštadienį' }, { id: 'b', 'org.matrix.msc1767.text': 'Sekmadienį' }] } } }
  const vote = (s, ids, ts) => ({ event_id: `$v${ts}`, type: 'org.matrix.msc3381.poll.response', sender: s, origin_server_ts: ts,
    content: { 'm.relates_to': { rel_type: 'm.reference', event_id: '$p' }, 'org.matrix.msc3381.poll.response': { answers: ids } } })
  const room = { id: 'r', timeline: [start, vote('@me:x', ['a'], 2), vote('@w:x', ['b'], 3), vote('@me:x', ['b'], 4)], reachedStart: true }
  const { entries } = mergedTimeline({ rooms: ['r'] }, { r: room })
  assert.equal(entries.length, 1)
  const poll = pollOf(entries[0].ev)
  assert.equal(poll.question, 'Kada žaidžiam?')
  assert.deepEqual(tallyPoll(poll, entries[0].votes), { a: [], b: ['@me:x', '@w:x'] })
  assert.equal(previewText(start, '@me:x'), '📊 Kada žaidžiam?')
  assert.equal(isDisplayable({ type: 'org.matrix.msc3381.poll.response', content: {} }), false)
})

test('delete for everyone: own messages, within the app limit', () => {
  const t = Date.now()
  const ev = { event_id: '$1', type: 'm.room.message', sender: '@me:x', origin_server_ts: t - 3600_000, content: { msgtype: 'm.text', body: 'x' } }
  assert.equal(canDelete({ features: { delete: 2, delete_max_age: 172800 } }, ev, '@me:x', t), true)
  assert.equal(canDelete({ features: { delete: 2, delete_max_age: 172800 } }, { ...ev, origin_server_ts: t - 3 * 86400_000 }, '@me:x', t), false)
  assert.equal(canDelete({ features: { delete: 2 } }, { ...ev, sender: '@x:x' }, '@me:x', t), false)
  assert.equal(canDelete({ features: null }, ev, '@me:x', t), false)
})

test('unnamed groups are titled with their members', async () => {
  const { groupTitle } = await import('./people.js')
  const room = { members: { '@me:x': { displayname: 'Me', membership: 'join' }, '@whatsapp_1:x': { displayname: 'Jonas Kazlauskas', membership: 'join' }, '@whatsapp_37061234567:x': { displayname: '', membership: 'join' }, '@whatsappbot:x': { displayname: 'bot', membership: 'join' } }, heroes: [], bridge: { bridgebot: '@whatsappbot:x' } }
  assert.equal(groupTitle(room, '@me:x'), 'Jonas, +37061234567')
})

test('contacts: the same full name saved twice still matches (the fuller card)', async () => {
  const { indexContacts, contactMatch } = await import('./contacts.js')
  const idx = indexContacts({ contacts: [{ id: 'a', n: 'Jonas Jonaitis' }, { id: 'b', n: 'Jonaitis Jonas', p: ['+37061234567'] }, { id: 'c', n: 'Ona' }] })
  assert.equal(contactMatch(idx, { names: ['Jonas Jonaitis'] })?.contact.id, 'b')
  assert.equal(contactMatch(idx, { names: ['Ona'] }), null)
})

test('WhatsApp hidden IDs get their number from the published map', async () => {
  const { phoneFromUser, setLidPhones } = await import('./networks.js')
  setLidPhones({ '12345678901234': '37061234567' })
  assert.equal(phoneFromUser('@whatsapp_lid-12345678901234:x'), '37061234567')
  assert.equal(phoneFromUser('@whatsapp_lid-999:x'), null)
  setLidPhones({})
})
