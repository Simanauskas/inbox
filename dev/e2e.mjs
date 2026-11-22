// End-to-end check against the dev Synapse + mock bridge.
//   node dev/e2e.mjs [screenshot-dir]
import { createRequire } from 'node:module'
const { chromium, devices } = createRequire(import.meta.url)('playwright')
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] || path.join(here, 'shots')
const APP = process.env.APP_URL || 'http://localhost:5180'
const mock = (...a) => execFileSync('python3', [path.join(here, 'mockbridge.py'), ...a], { encoding: 'utf8' })
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m) }

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
await page.goto(APP)
await page.getByLabel('Server').fill('http://localhost:8008')
await page.getByLabel('Username').fill('simas')
await page.getByLabel('Password').fill('test1234')
await page.getByRole('button', { name: 'Sign in' }).click()
await page.getByText('Hyrox crew').waitFor()
await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/1-inbox.png` })
assert(await page.getByText(/people are on more than one app/).isVisible(), 'merge suggestions banner shows')

await page.getByText(/people are on more than one app/).click()
await page.getByRole('button', { name: 'Combine' }).first().waitFor()
await page.screenshot({ path: `${out}/2-combine.png`, fullPage: true })
const cards = await page.locator('.sugg').count()
assert(cards === 4, `4 suggestions (Rokas, Ilona, Mantas, Eglė) – got ${cards}`)
await page.getByRole('button', { name: 'Combine all' }).click()
await page.getByText('Nothing to combine right now').waitFor()
await page.getByLabel('Back').click()

const rows = await page.locator('.list .row').count()
assert(rows === 6, `inbox has 6 entries after merging (4 people + Tomas + group) – got ${rows}`)
assert(await page.getByRole('button', { name: 'Show 1 chat with no messages yet' }).isVisible(), 'chat with no messages is tucked away at the bottom')
await page.screenshot({ path: `${out}/3-inbox-merged.png` })

// your phone book names people: Rokas is saved as "Rokas P. (tennis)" in contacts
mock('contacts')
await page.locator('.row-name', { hasText: 'Rokas P. (tennis)' }).waitFor({ timeout: 10000 })
assert(true, 'name comes from your phone book (Rokas P. (tennis)), not from the app')

await page.locator('.row', { hasText: 'Rokas' }).click()
await page.locator('.ch-pick').first().waitFor()
await page.waitForTimeout(800)
const via = async () => page.locator('.ch-pick[aria-checked="true"]').getAttribute('aria-label')
assert((await via()).includes('Telegram'), 'reply goes to Telegram (Rokas wrote there 3h ago)')
assert((await page.locator('.composer').boundingBox()).height < 70, 'bottom bar is a single row')
assert((await page.locator('.msg-net').count()) >= 3, 'merged thread shows app switches')
await page.screenshot({ path: `${out}/4-thread.png` })

await page.getByPlaceholder(/Message on/).fill('Yes, count me in for Saturday')
await page.getByLabel('Send', { exact: true }).click()
await page.waitForTimeout(1200)
assert(mock('messages', 'telegram', 'rokas').includes('count me in'), 'message landed in the Telegram chat')
assert(!mock('messages', 'whatsapp', 'rokas').includes('count me in'), '...and not in WhatsApp')
const myMsg = page.locator('.msg.out', { hasText: 'count me in' })
assert((await myMsg.locator('.ticks').getAttribute('title')) === 'Sent to your server', 'my message shows ✓ (sent)')
mock('delivered', 'telegram', 'rokas')
await myMsg.locator('.ticks.delivered').waitFor()
assert(true, 'bridge confirms it: ✓✓ delivered')
mock('read', 'telegram', 'rokas')
await myMsg.locator('.ticks.seen').waitFor()
assert(await page.locator('.seen', { hasText: 'Seen' }).isVisible(), 'he read it: "Seen" under my message')

// press and hold a message for reactions; a plain tap does nothing
const hisMsg = page.locator('.msg.in .bubble', { hasText: 'Are you in for the sim' })
await hisMsg.click()
assert(!(await page.locator('.actions').isVisible()), 'a tap does not open the reaction bar')
const box = await hisMsg.boundingBox()
await page.mouse.move(box.x + 20, box.y + 15)
await page.mouse.down()
await page.waitForTimeout(600)
await page.mouse.up()
await page.locator('.actions').waitFor()
await page.screenshot({ path: `${out}/4b-long-press.png` })
const barBox = await page.locator('.actions').boundingBox()
const bubBox = await hisMsg.boundingBox()
assert(barBox.y + barBox.height <= bubBox.y + 6 || barBox.y >= bubBox.y + bubBox.height - 6, 'reaction bar floats next to the message (not pushing it around)')
await page.locator('.actions button', { hasText: '❤️' }).click()
await page.locator('.reactions', { hasText: '❤️' }).waitFor()
assert(true, 'press and hold → ❤️ reaction is added')
// any other emoji via ＋
const box2 = await hisMsg.boundingBox()
await page.mouse.move(box2.x + 20, box2.y + 15); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up()
await page.getByLabel('More emojis').click()
await page.locator('.emoji-grid button', { hasText: '🎉' }).click()
await page.locator('.reactions', { hasText: '🎉' }).waitFor()
assert(true, '＋ → any emoji (🎉) is added')

mock('say', 'whatsapp', 'rokas', 'Also bring the sled straps pls')
await page.getByText('Also bring the sled straps').waitFor()
await page.waitForTimeout(300)
assert((await via()).includes('WhatsApp'), 'after he writes on WhatsApp, reply switches to WhatsApp')
await page.screenshot({ path: `${out}/5-thread-switch.png` })

await page.getByRole('radio', { name: /^Telegram/ }).click()
assert((await via()).includes('Telegram'), 'manual pick to Telegram (tap its badge at the top) sticks')
await page.screenshot({ path: `${out}/6-header-pick.png` })

// voice message: mic when the field is empty → record → send
await page.getByLabel('Record voice message').click()
await page.getByText(/Recording for Telegram/).waitFor()
await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/6b-recording.png` })
await page.getByLabel('Send voice message').click()
let voiceSent = false
for (let i = 0; i < 20 && !voiceSent; i++) { await page.waitForTimeout(500); voiceSent = mock('messages', 'telegram', 'rokas').includes('Voice message') }
assert(voiceSent, 'voice message recorded and sent to Telegram')
// it must be a real Ogg/Opus voice note (WhatsApp accepts nothing else)
const voice = await page.evaluate(async (roomId) => {
  const s = JSON.parse(localStorage.getItem('inbox.session'))
  const h = { Authorization: `Bearer ${s.accessToken}` }
  const r = await (await fetch(`${s.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`, { headers: h })).json()
  const ev = r.chunk.find((e) => e.content?.msgtype === 'm.audio')
  const [server, id] = ev.content.url.slice(6).split('/')
  const bytes = new Uint8Array(await (await fetch(`${s.baseUrl}/_matrix/client/v1/media/download/${server}/${id}`, { headers: h })).arrayBuffer())
  return { mime: ev.content.info.mimetype, voice: !!ev.content['org.matrix.msc3245.voice'], b64: btoa(String.fromCharCode(...bytes)) }
}, JSON.parse(mock('rooms')).rooms['telegram:rokas'])
assert(voice.mime === 'audio/ogg; codecs=opus' && voice.voice, `sent as an Ogg/Opus voice note (${voice.mime})`)
const oggPath = path.join(out, 'voice.ogg')
fs.writeFileSync(oggPath, Buffer.from(voice.b64, 'base64'))
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=format_name,duration', '-of', 'compact', oggPath], { encoding: 'utf8' })
execFileSync('ffmpeg', ['-v', 'error', '-i', oggPath, '-f', 'null', '-'])
assert(/codec_name=opus/.test(probe) && /format_name=ogg/.test(probe), `the file is valid Ogg/Opus and decodes (${probe.replace(/\n/g, ' ').trim()})`)

// photo with a caption, like WhatsApp: picking it shows a preview, the text becomes the caption
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
await page.locator('.composer input[type=file]').setInputFiles({ name: 'gym.png', mimeType: 'image/png', buffer: png })
await page.locator('.pending-item img').waitFor()
assert((await page.getByPlaceholder('Add a caption…').count()) === 1, 'picked photo waits above the text field for a caption')
await page.getByPlaceholder('Add a caption…').fill('10 min done 💪')
await page.getByLabel('Send', { exact: true }).click()
let captioned = null
for (let i = 0; i < 20 && !captioned; i++) {
  await page.waitForTimeout(500)
  captioned = mock('messages', 'telegram', 'rokas').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.msgtype === 'm.image')
}
assert(captioned && captioned.body === '10 min done 💪' && captioned.filename === 'gym.png', 'photo sent with its caption')

// while his chat is open, his messages don't notify (a push rule per open room), and that stops when leaving
const rules = () => page.evaluate(async () => {
  const s = JSON.parse(localStorage.getItem('inbox.session'))
  const r = await (await fetch(`${s.baseUrl}/_matrix/client/v3/pushrules/`, { headers: { Authorization: `Bearer ${s.accessToken}` } })).json()
  return r.global.override.filter((x) => x.rule_id.startsWith('inbox-open-')).map((x) => x.rule_id)
})
const rr = JSON.parse(mock('rooms')).rooms
let open = await rules()
assert(open.includes('inbox-open-' + rr['telegram:rokas']) && open.includes('inbox-open-' + rr['whatsapp:rokas']), 'his chats are quiet while open')
await page.getByLabel('Back').click()
await page.waitForTimeout(800)
open = await rules()
assert(open.length === 0, 'notifications come back after leaving the chat')
await page.locator('.row', { hasText: 'Rokas' }).click()
await page.locator('.ch-pick').first().waitFor()

await page.locator('.thread-name').click()
await page.getByText('Make default').first().waitFor()
assert(await page.getByText('Named as in').isVisible(), 'contact page says the name comes from your contacts')
await page.screenshot({ path: `${out}/7-person.png` })

await page.goto(APP + '/#/settings')
await page.getByText('Connected apps').waitFor()
await page.getByLabel('Your reaction emojis').fill('🔥👍🏽🫶')
await page.getByRole('button', { name: 'Save' }).click()
await page.waitForTimeout(500)
await page.goto(APP + '/#/t/' + encodeURIComponent('r:' + JSON.parse(mock('rooms')).rooms['telegram:mantas']))
const mb = page.locator('.msg.in .bubble').last()
await mb.waitFor(); await mb.scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
const b3 = await mb.boundingBox()
await page.mouse.move(b3.x + 20, b3.y + 15); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up()
const firstEmojis = await page.locator('.actions button').allInnerTexts()
assert(firstEmojis.slice(0, 3).join('') === '🔥👍🏽🫶', `your own reaction emojis from Settings are in the bar (${firstEmojis.slice(0, 4).join(' ')})`)
await page.goto(APP + '/#/settings')
await page.getByText('Connected apps').waitFor()
await page.screenshot({ path: `${out}/8-settings.png`, fullPage: true })

// reopening uses the copy saved on the device: the list shows even if the server is slow to answer
await page.evaluate(() => new Promise((r) => { document.dispatchEvent(new Event('visibilitychange')); setTimeout(r, 300) }))
const cached = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('inbox', 1)
  req.onsuccess = () => { const g = req.result.transaction('kv').objectStore('kv').get('sync:@simas:inbox.test'); g.onsuccess = () => resolve(g.result ? g.result.rooms.length : 0) }
  req.onerror = () => resolve(0)
}))
assert(cached >= 10, `chat list saved on the device (${cached} chats)`)
await page.route('**/_matrix/client/v3/sync**', () => {}) // never answers
await page.goto(APP + '/#/')
await page.locator('.row', { hasText: 'Rokas' }).waitFor({ timeout: 5000 })
assert((await page.locator('.list .row').count()) === 6, 'reopened with the server not answering: all 6 entries shown from the saved copy')
await page.unroute('**/_matrix/client/v3/sync**')
await page.locator('.row', { hasText: 'Rokas' }).click()
await page.getByText('Also bring the sled straps').waitFor()
assert(true, 'opening a chat from the saved copy shows its messages')

// tapping a notification while the app is closed: the service worker leaves a note,
// the app starts at its home page (as iOS may do) and must jump straight into the chat
const rooms = JSON.parse(mock('rooms')).rooms
const hash = '#/t/' + encodeURIComponent('r:' + rooms['telegram:mantas'])
await page.evaluate((h) => new Promise((resolve) => {
  const req = indexedDB.open('inbox', 1)
  req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ hash: h, at: Date.now() }, 'pendingOpen'); tx.oncomplete = resolve }
}), hash)
await page.goto(APP + '/')
await page.locator('.thread-head', { hasText: 'Mantas' }).waitFor({ timeout: 5000 })
assert(true, 'notification tap opens the chat directly, even if the app starts at its home page')

// iCloud contacts, with the real server/contacts.py against a stand-in CardDAV
// server (Radicale on DAV_URL, any login): saving a new contact and adding a
// number to an existing card, each only after confirming
const DAV = process.env.DAV_URL || 'http://localhost:5232'
const davUp = await fetch(DAV + '/').then(() => true, () => false)
if (!davUp) console.log(`skip - iCloud contacts (no CardDAV server at ${DAV})`)
else {
  const auth = { Authorization: 'Basic ' + Buffer.from('simas:x').toString('base64') }
  const book = `${DAV}/simas/inbox-e2e/`
  await fetch(book, { method: 'DELETE', headers: auth })
  await fetch(book, { method: 'MKCOL', headers: { ...auth, 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><set><prop><resourcetype><collection/><C:addressbook/></resourcetype></prop></set></mkcol>' })
  for (const [id, lines] of [['rokas', ['FN:Rokas P. (tennis)', 'N:P.;Rokas;;;', 'TEL;TYPE=CELL:8 612 34567']], ['egle', ['FN:Eglė Žemaitė', 'N:Žemaitė;Eglė;;;', 'EMAIL:egle@example.com']]]) {
    await fetch(`${book}${id}.vcf`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/vcard' }, body: ['BEGIN:VCARD', 'VERSION:3.0', `UID:${id}`, ...lines, 'END:VCARD', ''].join('\r\n') })
  }
  const asToken = fs.readFileSync(path.join(here, 'data', 'mockbridge.yaml'), 'utf8').match(/as_token: "([^"]+)"/)[1]
  const service = () => execFileSync('python3', [path.join(here, '..', 'server', 'contacts.py'), '--once'], {
    encoding: 'utf8',
    env: { ...process.env, HS: 'http://localhost:8008', AS_TOKEN: asToken, USER_ID: '@simas:inbox.test', ICLOUD_USER: 'simas', ICLOUD_APP_PASSWORD: 'x', ICLOUD_CARDDAV_URL: DAV + '/', STATE: path.join(out, 'contacts.state') },
  })
  console.log(service().trim().replace(/^/gm, '  contacts.py: '))

  // Ilona isn't in the phone book: add her, under a name you choose
  await page.goto(APP + '/#/')
  await page.locator('.row', { hasText: 'Ilona' }).click()
  await page.locator('.thread-name').click()
  await page.getByRole('button', { name: 'Add to contacts' }).click()
  const sheet = page.getByRole('dialog', { name: 'Contact card' })
  await sheet.getByText('+37069876543').waitFor()
  await sheet.getByLabel('Name').fill('Ilona (gym)')
  await sheet.getByRole('button', { name: 'Save to iCloud' }).waitFor()
  await page.screenshot({ path: `${out}/10-save-contact.png` })
  await sheet.getByRole('button', { name: 'Save to iCloud' }).click()
  await sheet.getByText('Saving to iCloud').waitFor()
  console.log(service().trim().replace(/^/gm, '  contacts.py: '))
  await sheet.getByText(/Saved to iCloud \(created\)/).waitFor({ timeout: 10000 })
  assert(true, 'new contact is saved to iCloud after you confirm, and the app says so')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await page.getByText('Named as in').waitFor({ timeout: 10000 })
  assert(await page.getByLabel('Name', { exact: true }).inputValue() === 'Ilona (gym)', 'she is now called by the name you saved')
  const listing = await (await fetch(book, { method: 'PROPFIND', headers: { ...auth, Depth: '1' } })).text()
  const created = [...listing.matchAll(/<href>([^<]+\.vcf)<\/href>/g)].map((m) => m[1]).filter((h) => !/rokas|egle/.test(h))
  const card = await (await fetch(new URL(created[0], DAV), { headers: auth })).text()
  assert(card.includes('FN:Ilona (gym)') && card.includes('+37069876543'), 'the card on the CardDAV server has her name and number')

  // Eglė is saved with only an email: offer to add the WhatsApp number to her card
  await page.goto(APP + '/#/')
  await page.locator('.row', { hasText: 'Eglė' }).click()
  await page.locator('.thread-name').click()
  await page.getByRole('button', { name: 'Update contact card' }).click()
  await sheet.getByText('+37065554433').waitFor()
  await sheet.getByRole('button', { name: 'Save to iCloud' }).click()
  await sheet.getByText('Saving to iCloud').waitFor()
  console.log(service().trim().replace(/^/gm, '  contacts.py: '))
  await sheet.getByText(/Saved to iCloud \(updated/).waitFor({ timeout: 10000 })
  await sheet.getByRole('button', { name: 'Close' }).click()
  const egle = await (await fetch(`${book}egle.vcf`, { headers: auth })).text()
  assert(egle.includes('37065554433') && egle.includes('EMAIL:egle@example.com'), 'existing card gets the number, keeping what was on it')
  await page.getByRole('button', { name: 'Update contact card' }).waitFor({ state: 'detached', timeout: 10000 })
  assert(true, 'nothing left to suggest once the card has it')
}

// desktop layout (fresh context; give the first sync a moment to pick up the merge)
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() })
const dp = await desk.newPage()
await dp.goto(APP)
await dp.waitForTimeout(1500)
await dp.locator('.row', { hasText: 'Ilona' }).click()
await dp.waitForTimeout(800)
assert((await dp.locator('.msg-net').count()) >= 3, 'desktop: Ilona thread merges WhatsApp, Instagram and Messenger')
await dp.screenshot({ path: `${out}/9-desktop.png` })
await browser.close()
console.log('all checks passed')
