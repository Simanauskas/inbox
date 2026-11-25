import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupMembers, canDo, addable, ghostFor, groupCaps } from './group.js'
import { isDisplayable } from './people.js'
import { indexContacts } from './contacts.js'

const ME = '@s:x'
const mem = (displayname, membership = 'join') => ({ displayname, membership })
const group = {
  id: '!g', bridge: { bridgebot: '@whatsappbot:x' },
  members: {
    [ME]: mem('Me'), '@whatsappbot:x': mem('bot'),
    '@whatsapp_37061111111:x': mem('Tomas'), '@whatsapp_37062222222:x': mem('Ugne'),
    '@whatsapp_lid-999:x': mem('Zed'), '@whatsapp_37063333333:x': mem('Gone', 'leave'),
  },
  power: { users: { '@whatsappbot:x': 100, [ME]: 50, '@whatsapp_37062222222:x': 50 }, users_default: 0, invite: 0, kick: 50, events: { 'm.room.name': 50 } },
}
const person = { key: 'p:1', kind: 'person', name: 'Ugnė Petraitė', rooms: ['!dm'], nameSource: 'contacts' }
const model = {
  items: [person, { key: 'p:2', kind: 'person', name: 'Rokas', rooms: ['!dm2'] }, { key: 'p:3', kind: 'person', name: 'Ieva', rooms: ['!tg'] }],
  info: { '!g': { network: 'whatsapp' }, '!dm': { network: 'whatsapp', kind: 'dm', remote: '@whatsapp_37062222222:x' }, '!dm2': { network: 'whatsapp', kind: 'dm', remote: '@whatsapp_37064444444:x' }, '!tg': { network: 'telegram', kind: 'dm', remote: '@telegram_5:x' } },
}
const contacts = indexContacts({ contacts: [{ id: 'c1', n: 'Tomas Jonaitis', p: ['+370 611 11111'] }] })

test('members: you first, then admins, names from contacts, no bots or people who left', () => {
  const list = groupMembers(group, ME, { model, contactIdx: contacts })
  assert.deepEqual(list.map((m) => m.name), ['You', 'Ugnė Petraitė', 'Tomas Jonaitis', 'Zed'])
  const ugne = list[1]
  assert.equal(ugne.admin, true)
  assert.equal(ugne.item.key, 'p:1')
  assert.equal(list[2].contact.id, 'c1')
  assert.equal(list[3].phone, null)
})

test('rights come from power levels', () => {
  assert.equal(canDo(group, ME, 'kick'), true)
  assert.equal(canDo(group, '@whatsapp_37061111111:x', 'kick'), false)
  assert.equal(canDo(group, ME, 'm.room.name'), true)
  assert.equal(canDo({ power: null }, ME, 'invite'), true)
})

test('add: people with a chat on the same app who are not in the group', () => {
  assert.deepEqual(addable(group, ME, model).map((a) => a.item.key), ['p:2'])
  assert.deepEqual(addable(group, ME, model, 'xyz'), [])
})

test('add by number uses the group bridge ghost format', () => {
  assert.equal(ghostFor(group, ME, '+370 612 34567'), '@whatsapp_37061234567:x')
  assert.equal(ghostFor(group, ME, '12'), null)
})

test('iMessage groups are view-only', () => {
  assert.equal(groupCaps('imessage').add, undefined)
  assert.equal(groupCaps('whatsapp').link, '!wa invite-link')
})

test('invite-link command and the bridge answer are not shown as messages', () => {
  assert.equal(isDisplayable({ type: 'm.room.message', sender: ME, content: { msgtype: 'm.text', body: '!wa invite-link' } }), false)
  assert.equal(isDisplayable({ type: 'm.room.message', sender: '@whatsappbot:x', content: { msgtype: 'm.notice', body: 'https://chat.whatsapp.com/AbC123' } }), false)
  assert.equal(isDisplayable({ type: 'm.room.message', sender: '@whatsapp_1:x', content: { msgtype: 'm.text', body: 'https://chat.whatsapp.com/AbC123' } }), true)
})
