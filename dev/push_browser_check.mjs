// Browser-side push check against a server set up with server/setup.sh
// (with PUSH_EXTRA_ENDPOINT=mockpush in its .env) and the built app served by
// `npm run preview -- --port 5181`.
//
//   node dev/push_browser_check.mjs <server dir> <http://localhost:8008> <user> <password>
//
// The browser can't reach a real push service here, so its subscription is
// stubbed to point at a stand-in push service on the server's Docker network.
// Everything else is real: the app registers the pusher, Synapse and Sygnal
// deliver to the stand-in, and the service worker's push handler is driven
// with Chrome DevTools' "deliver push message".
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomBytes, createECDH } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const { chromium } = createRequire(import.meta.url)('playwright')
const [serverDir, HS, USER, PASS] = process.argv.slice(2)
const APP = process.env.APP_URL || 'http://localhost:5181'
const project = path.basename(path.resolve(serverDir)).toLowerCase()
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m) }
const b64 = (b) => Buffer.from(b).toString('base64url')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, p, body, token) {
  const r = await fetch(HS + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`)
  return j
}
const login = (u, p) => api('POST', '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: u }, password: p })

// stand-in push service
const inbox = path.join(serverDir, 'data', 'mockpush')
fs.mkdirSync(inbox, { recursive: true })
for (const f of fs.readdirSync(inbox)) fs.unlinkSync(path.join(inbox, f))
const receiver = `
import http.server, time
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        open("/out/%d.bin" % (time.time()*1000), "wb").write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(201); self.send_header("Content-Length", "0"); self.end_headers()
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()`
try { execFileSync('docker', ['rm', '-f', 'mockpush'], { stdio: 'ignore' }) } catch {}
execFileSync('docker', ['run', '-d', '--name', 'mockpush', '--network', `${project}_default`, '-v', `${path.resolve(inbox)}:/out`, 'python:3-alpine', 'python', '-c', receiver])

// the subscription the browser will "get" from its push service
const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
const sub = { endpoint: 'http://mockpush/push', p256dh: b64(ecdh.getPublicKey()), auth: b64(randomBytes(16)) }

const me = await login(USER, PASS)
// clear pushers left by earlier test runs, so each message is pushed once
for (const p of (await api('GET', '/_matrix/client/v3/pushers', null, me.access_token)).pushers) {
  if (p.data?.endpoint === sub.endpoint) await api('POST', '/_matrix/client/v3/pushers/set', { kind: null, app_id: p.app_id, pushkey: p.pushkey }, me.access_token)
}
// full headless mode: the slim headless shell always reports notifications as blocked
const browser = await chromium.launch({ channel: 'chromium' })
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } })
await ctx.grantPermissions(['notifications'], { origin: APP })
await ctx.addInitScript((s) => {
  const raw = (b) => Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer
  const fake = { endpoint: s.endpoint, getKey: (k) => raw(k === 'p256dh' ? s.p256dh : s.auth), unsubscribe: async () => { localStorage.setItem('test.unsubscribed', '1'); return true } }
  if (self.PushManager) {
    PushManager.prototype.subscribe = async function () { localStorage.setItem('test.subscribed', '1'); return fake }
    PushManager.prototype.getSubscription = async function () { return localStorage.getItem('test.subscribed') && !localStorage.getItem('test.unsubscribed') ? fake : null }
  }
}, sub)
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
await page.goto(APP)
await page.getByLabel('Server').fill(HS)
await page.getByLabel('Username').fill(USER)
await page.getByLabel('Password').fill(PASS)
await page.getByRole('button', { name: 'Sign in' }).click()
await page.getByText('Inbox', { exact: true }).first().waitFor()
await page.goto(APP + '/#/settings')
await page.getByRole('button', { name: 'Turn on notifications' }).click()
await page.getByText(/On\. You'll be notified/).waitFor({ timeout: 15000 })
assert(true, 'settings shows notifications on')

const pushers = (await api('GET', '/_matrix/client/v3/pushers', null, me.access_token)).pushers
const mine = pushers.find((p) => p.pushkey === sub.p256dh)
assert(mine, 'app registered a pusher with the server')
assert(mine.app_id === 'fit.simas.inbox.web' && mine.data.endpoint === sub.endpoint && mine.data.auth === sub.auth && mine.data.events_only === true,
  'pusher has the right gateway, endpoint, auth and events_only')
const rule = await api('GET', '/_matrix/client/v3/pushrules/global/override/.m.rule.invite_for_me/enabled', null, me.access_token)
assert(rule.enabled === false, 'invite notifications switched off (bridges invite you to every imported chat)')

// a real message from someone else goes Synapse -> Sygnal -> push service
const other = 'pb' + randomBytes(3).toString('hex')
execFileSync('docker', ['compose', 'exec', '-T', 'synapse', 'register_new_matrix_user', '-c', '/data/homeserver.yaml', '-u', other, '-p', 'pw-' + other, '--no-admin', 'http://localhost:8008'], { cwd: serverDir, stdio: 'ignore' })
const them = await login(other, 'pw-' + other)
await api('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(them.user_id)}/displayname`, { displayname: 'Rokas' }, them.access_token)
const room = (await api('POST', '/_matrix/client/v3/createRoom', { invite: [me.user_id], is_direct: true, preset: 'trusted_private_chat' }, them.access_token)).room_id
await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, me.access_token)
const fresh = (await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/t${Date.now()}`, { msgtype: 'm.text', body: 'Sauna at 7?' }, them.access_token)).event_id
let pushes = []
for (let i = 0; i < 40 && !pushes.length; i++) { await sleep(500); pushes = fs.readdirSync(inbox) }
assert(pushes.length === 1, `exactly one push delivered for the message, none for the invite (got ${pushes.length})`)

// an "imported" old message: send with an old timestamp via the double-puppet appservice
const dp = fs.readFileSync(path.join(serverDir, 'data', 'synapse', 'doublepuppet.yaml'), 'utf8').match(/as_token: "([^"]+)"/)[1]
const oldTs = Date.now() - 3 * 86400_000
const old = (await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/o${Date.now()}?user_id=${encodeURIComponent(them.user_id)}&ts=${oldTs}`, { msgtype: 'm.text', body: 'from three days ago' }, dp)).event_id

// drive the service worker's push handler like the browser would
const cdp = await ctx.newCDPSession(page)
let regId = null
cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) if (!r.isDeleted) regId = r.registrationId })
await cdp.send('ServiceWorker.enable')
for (let i = 0; i < 20 && !regId; i++) await sleep(200)
const origin = new URL(APP).origin
const deliver = (payload) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: regId, data: JSON.stringify(payload) })
const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })))

await deliver({ room_id: room, event_id: fresh, sender_display_name: 'Rokas', room_name: 'Rokas', type: 'm.room.message', content: { msgtype: 'm.text', body: 'Sauna at 7?' }, unread: 1 })
await sleep(1500)
let ns = await shown()
assert(ns.some((n) => n.title === 'Rokas' && n.body === 'Sauna at 7?' && n.tag === room), 'new message shows as "Rokas: Sauna at 7?"')

await deliver({ room_id: room, event_id: old, sender_display_name: 'Rokas', room_name: 'Rokas', type: 'm.room.message', content: { msgtype: 'm.text', body: 'from three days ago' }, unread: 2 })
await sleep(1500)
ns = await shown()
assert(!ns.some((n) => n.body === 'from three days ago') && ns.some((n) => n.tag === 'inbox-import'), 'old imported message is folded into "Importing older messages…"')

// opening the chat clears its notification
await page.goto(APP + '/#/t/' + encodeURIComponent('r:' + room))
await page.getByText('Sauna at 7?').first().waitFor()
await sleep(1500)
ns = await shown()
assert(!ns.some((n) => n.tag === room), 'reading the chat clears its notification')

// turning it off removes the pusher
await page.goto(APP + '/#/settings')
await page.getByRole('button', { name: 'Turn off' }).click()
await page.getByRole('button', { name: 'Turn on notifications' }).waitFor()
const after = (await api('GET', '/_matrix/client/v3/pushers', null, me.access_token)).pushers
assert(!after.some((p) => p.pushkey === sub.p256dh), 'turning off removes the pusher')
await page.screenshot({ path: path.join(serverDir, 'push-settings.png') })

await browser.close()
try { execFileSync('docker', ['rm', '-f', 'mockpush'], { stdio: 'ignore' }) } catch {}
console.log('all browser push checks passed')
