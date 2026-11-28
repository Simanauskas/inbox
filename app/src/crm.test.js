import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crmFor, profileOf, setField, addTag, removeTag, markFact, addNote, keepCard, peopleSections, drifting, directoryFrom, sinceText } from './crm.js'

const DAY = 86400_000
const NOW = 1_700_000_000_000
const crm = {
  people: {
    '!a': { name: 'Jonas Jonaitis', rooms: ['!a', '!b'], learned: { circle: 'friend', strength: 55, tags: ['tennis'], work: { company: 'Acme', role: 'Engineer' }, met: { how: 'school', since: 2006 } },
      facts: [{ id: 1, text: 'Has a dog', ts: NOW - 5 * DAY, status: 'current' }, { id: 2, text: 'Lives in Kaunas', ts: NOW - 9 * DAY, status: 'current' }],
      stats: { last: NOW - 100 * DAY }, card: { conflicts: [{ field: 'org', card: 'OldCo', learned: 'Acme' }] } },
    '!c': { name: 'Ugnė Petraitė', rooms: ['!c'], learned: { circle: 'colleague', strength: 30 }, facts: [], stats: { last: NOW - DAY } },
  },
}

test('finds the entry by shared chats', () => {
  assert.equal(crmFor(crm, { rooms: ['!b', '!z'] }).cid, '!a')
  assert.equal(crmFor(crm, { rooms: ['!z'] }), null)
})

test('his values win over learned ones, and say why', () => {
  let e = setField({}, '!a', 'Jonas', 'circle', 'close friend', 'known 20 years')
  e = setField(e, '!a', 'Jonas', 'strength', 90)
  const p = profileOf({ cid: '!a', ...crm.people['!a'] }, e)
  assert.equal(p.circle, 'close friend')
  assert.equal(p.strength, 90)
  assert.equal(p.suggested.circle, 'friend')
  assert.equal(e.people['!a'].why.circle, 'known 20 years')
  assert.equal(p.company, 'Acme')
  assert.equal(profileOf({ cid: '!a', ...crm.people['!a'] }, setField(e, '!a', 'Jonas', 'circle', null)).circle, 'friend')
})

test('tags, facts, own notes, card conflicts', () => {
  let e = addTag({}, '!a', 'Jonas', 'Neighbours')
  e = removeTag(e, '!a', 'Jonas', 'tennis')
  e = markFact(e, '!a', 'Jonas', { id: 2, text: 'Lives in Kaunas' }, 'wrong', 'moved to Vilnius')
  e = addNote(e, '!a', 'Jonas', 'Owes me a book')
  e = keepCard(e, '!a', 'Jonas', 'org', 'OldCo')
  const p = profileOf({ cid: '!a', ...crm.people['!a'] }, e)
  assert.deepEqual(p.tags, ['neighbours'])
  assert.deepEqual(p.facts.map((f) => f.text), ['Owes me a book', 'Has a dog'])
  assert.equal(p.conflicts.length, 0)
})

test('people page: by circle, closest first; drifting friends', () => {
  const s = peopleSections(crm, {}, {}, NOW)
  assert.deepEqual(s.map((x) => x.circle), ['friend', 'colleague'])
  assert.equal(peopleSections(crm, {}, { tag: 'tennis' }, NOW)[0].people[0].name, 'Jonas Jonaitis')
  assert.equal(peopleSections(crm, {}, { q: 'acme' }, NOW).length, 1)
  assert.equal(drifting(profileOf({ cid: '!a', ...crm.people['!a'] }, {}), NOW), false) // 55 → 120 days
  assert.equal(drifting(profileOf({ cid: '!a', ...crm.people['!a'] }, setField({}, '!a', 'J', 'strength', 90)), NOW), true)
  assert.equal(sinceText(NOW - 100 * DAY, NOW), '3 months ago')
})

test('directory lists people only, with their card', () => {
  const model = { items: [{ kind: 'person', key: 'p:1', name: 'A', rooms: ['!y', '!x'], contact: { id: 'https://c/1.vcf' } }, { kind: 'group', key: 'r:!g', name: 'G', rooms: ['!g'] }] }
  assert.deepEqual(directoryFrom(model), [{ key: 'p:1', name: 'A', rooms: ['!x', '!y'], href: 'https://c/1.vcf' }])
})
