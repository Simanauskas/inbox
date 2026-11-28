// A small Matrix client: just what the inbox needs. Rooms on your own server
// are unencrypted (the bridges run there), so there is no crypto here.

import { idbGet, idbSet, idbDel } from './idb.js'
import { webmOpusToOgg } from './ogg.js'

const filter = (limit) => ({
  room: {
    timeline: { limit },
    state: { lazy_load_members: true },
    ephemeral: { types: ['m.receipt', 'm.typing'] },
    account_data: { types: ['m.fully_read', 'm.marked_unread', 'com.famedly.marked_unread', 'fit.simas.inbox.suggest', 'fit.simas.inbox.plan', 'fit.simas.inbox.transcripts'] },
  },
  presence: { not_types: ['*'] },
})
// The first load asks for only a few messages per chat (enough for the list
// and its ordering): with hundreds of bridged chats, 20 each made the first
// load take minutes, longer than Cloudflare waits. Opening a chat loads more.
const INITIAL_FILTER = filter(5)
const SYNC_FILTER = filter(20)

// What's kept on the device so the app opens instantly next time.
const CACHE_VERSION = 1
const CACHE_EVENTS_PER_ROOM = 15

export const VIEWING_TYPE = 'fit.simas.inbox.viewing'

export const PEOPLE_TYPE = 'fit.simas.inbox.people'
export const SETTINGS_TYPE = 'fit.simas.inbox.settings'
const REACTION_RULE = 'fit.simas.inbox.reaction'
// "I'm in this chat right now", renewed every 20 s while you're active in it
const ACTIVE_TYPE = 'fit.simas.inbox.active'
const ACTIVE_FOR_MS = 90_000
const allReactionsRule = (roomId) => `fit.simas.inbox.reactions-all.${roomId}`

const txnId = () => `inbox${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export class MatrixError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`)
    this.status = status
    this.errcode = body?.errcode
  }
}

export async function login(baseUrl, user, password) {
  baseUrl = baseUrl.replace(/\/+$/, '')
  const r = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: 'Inbox',
    }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new MatrixError(r.status, body)
  return { baseUrl, userId: body.user_id, accessToken: body.access_token, deviceId: body.device_id }
}

function newRoom(id) {
  return {
    id,
    membership: 'join',
    name: null,
    avatarUrl: null,
    bridge: null, // content of m.bridge / uk.half-shot.bridge
    members: {}, // userId -> { displayname, avatarUrl, membership }
    heroes: [],
    joinedCount: 0,
    timeline: [], // sorted events (incl. local echoes)
    byId: {},
    prevBatch: null,
    reachedStart: false,
    notificationCount: 0,
    receipts: {}, // userId -> eventId (m.read)
    fullyRead: null,
    markedUnread: false, // you marked it unread (m.marked_unread)
    unreadCount: 0, // unread messages, muted chats included (server count)
    typing: [],
    createTs: 0,
  }
}

export class Client {
  constructor(session) {
    this.baseUrl = session.baseUrl
    this.userId = session.userId
    this.token = session.accessToken
    this.deviceId = session.deviceId || 'web'
    this.rooms = {}
    this.accountData = {}
    this.version = 0
    this.listeners = new Set()
    this.status = 'connecting' // connecting | live | offline | error
    this.synced = false
    this.media = new Map()
    this.mediaDone = new Map() // the same, already loaded (for drawing without a flash)
    this.stopped = false
    this.onLoggedOut = null
    this.onMessage = null // (room, event) for new inbound messages after first sync
  }

  // --- store plumbing ---
  subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  getVersion = () => this.version
  emit() { this.version++; for (const fn of this.listeners) fn() }

  // --- HTTP ---
  async api(method, path, body, { query, raw, contentType, keepalive } = {}) {
    const qs = query ? '?' + new URLSearchParams(query) : ''
    const r = await fetch(this.baseUrl + path + qs, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(raw ? { 'Content-Type': contentType || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw || (body ? JSON.stringify(body) : undefined),
      keepalive: !!keepalive,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      if (r.status === 401 && data.errcode === 'M_UNKNOWN_TOKEN') { this.stop(); this.clearCache(); this.onLoggedOut?.() }
      throw new MatrixError(r.status, data)
    }
    return data
  }

  // --- sync loop ---
  async start() {
    this.dropOpenChatRules()
    this.quietRooms([])
    // Show what we had last time straight away, then catch up from there.
    let since = await this.loadCache()
    let backoff = 1000
    const filters = {}
    for (const [name, f] of [['initial', INITIAL_FILTER], ['sync', SYNC_FILTER]]) {
      try {
        filters[name] = (await this.api('POST', `/_matrix/client/v3/user/${enc(this.userId)}/filter`, f)).filter_id
      } catch { filters[name] = JSON.stringify(f) }
    }
    this.cacheTimer = setInterval(() => this.saveCache(), 60_000)
    this.onHide = () => { if (document.visibilityState === 'hidden') this.saveCache() }
    document.addEventListener('visibilitychange', this.onHide)
    while (!this.stopped) {
      try {
        const query = { filter: since ? filters.sync : filters.initial, timeout: since ? '30000' : '0' }
        if (since) query.since = since
        const res = await this.api('GET', '/_matrix/client/v3/sync', null, { query })
        this.applySync(res, !since)
        const first = !since
        since = res.next_batch
        this.since = since
        backoff = 1000
        if (this.status !== 'live' || !this.synced) { this.status = 'live'; this.synced = true; this.emit() }
        if (first) this.saveCache()
      } catch (e) {
        if (this.stopped) return
        // a saved position the server no longer accepts: start over
        if (since && e instanceof MatrixError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          since = null
          this.rooms = {}
          this.synced = false
          await idbDel(this.cacheKey())
        }
        this.status = e instanceof MatrixError ? 'error' : 'offline'
        this.emit()
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  }

  stop() {
    this.stopped = true
    clearInterval(this.cacheTimer)
    if (this.onHide) document.removeEventListener('visibilitychange', this.onHide)
  }

  // --- on-device cache ---
  cacheKey() { return `sync:${this.userId}` }

  async loadCache() {
    const c = await idbGet(this.cacheKey())
    if (!c || c.version !== CACHE_VERSION || !c.since || this.stopped) return null
    for (const r of c.rooms) {
      const room = Object.assign(newRoom(r.id), r)
      room.byId = Object.fromEntries(room.timeline.map((e) => [e.event_id, e]))
      this.rooms[r.id] = room
    }
    this.accountData = c.accountData || {}
    this.since = c.since
    this.synced = true
    this.emit()
    return c.since
  }

  saveCache() {
    if (!this.since || !this.synced || this.stopped) return
    const rooms = []
    for (const room of Object.values(this.rooms)) {
      if (room.membership !== 'join') continue
      const events = room.timeline.filter((e) => !e.local)
      const cut = events.length > CACHE_EVENTS_PER_ROOM
      rooms.push({
        id: room.id, name: room.name, avatarUrl: room.avatarUrl, bridge: room.bridge, members: room.members,
        heroes: room.heroes, joinedCount: room.joinedCount, notificationCount: room.notificationCount, unreadCount: room.unreadCount || 0,
        receipts: room.receipts, fullyRead: room.fullyRead, markedUnread: !!room.markedUnread, suggest: room.suggest || null, plan: room.plan || null, transcripts: room.transcripts || null, createTs: room.createTs, roomType: room.roomType || null, topic: room.topic || null, power: room.power || null, features: room.features ?? null, disappearing: room.disappearing || null,
        timeline: events.slice(-CACHE_EVENTS_PER_ROOM),
        // a trimmed timeline can't continue from the old pagination token;
        // without one, the next "load older" starts from the newest and skips what it has
        prevBatch: cut ? null : room.prevBatch,
        reachedStart: cut ? false : room.reachedStart,
      })
    }
    return idbSet(this.cacheKey(), { version: CACHE_VERSION, since: this.since, accountData: this.accountData, rooms, savedAt: Date.now() })
  }

  clearCache() { return idbDel(this.cacheKey()) }

  applySync(res, initial) {
    for (const ev of res.account_data?.events || []) this.accountData[ev.type] = ev.content
    const join = res.rooms?.join || {}
    for (const [id, r] of Object.entries(join)) {
      const room = this.rooms[id] || (this.rooms[id] = newRoom(id))
      room.membership = 'join'
      for (const ev of r.state?.events || []) this.applyState(room, ev)
      if (r.summary) {
        if (r.summary['m.heroes']) room.heroes = r.summary['m.heroes']
        if (r.summary['m.joined_member_count'] != null) room.joinedCount = r.summary['m.joined_member_count']
      }
      const tl = r.timeline || {}
      if (tl.limited) {
        // gap: drop what we had (keep unsent local echoes) and restart from here
        room.timeline = room.timeline.filter((e) => e.local && e.status !== 'sent')
        room.byId = Object.fromEntries(room.timeline.map((e) => [e.event_id, e]))
        room.reachedStart = false
      }
      if (tl.prev_batch && (tl.limited || !room.prevBatch)) room.prevBatch = tl.prev_batch
      for (const ev of tl.events || []) {
        if (ev.state_key !== undefined) this.applyState(room, ev)
        const isNew = this.addEvent(room, ev)
        if (isNew && !initial && ev.sender !== this.userId && isMessage(ev)) this.onMessage?.(room, ev)
      }
      if (r.unread_notifications) room.notificationCount = r.unread_notifications.notification_count || 0
      // unread messages including muted chats (MSC2654; on sky since 24 Nov 2026)
      if (r['org.matrix.msc2654.unread_count'] !== undefined) room.unreadCount = r['org.matrix.msc2654.unread_count'] || 0
      for (const ev of r.ephemeral?.events || []) {
        if (ev.type === 'm.typing') room.typing = ev.content.user_ids || []
        if (ev.type === 'm.receipt') {
          for (const [eid, types] of Object.entries(ev.content)) {
            for (const uid of Object.keys(types['m.read'] || {})) {
              // you read this chat on another device: clear its notifications here too
              if (uid === this.userId && !initial && room.receipts[uid] !== eid) this.onRead?.(room.id)
              room.receipts[uid] = eid
            }
          }
        }
      }
      for (const ev of r.account_data?.events || []) {
        if (ev.type === 'm.fully_read') room.fullyRead = ev.content.event_id
        if (ev.type === 'm.marked_unread' || ev.type === 'com.famedly.marked_unread') room.markedUnread = !!ev.content?.unread
        if (ev.type === 'fit.simas.inbox.suggest') room.suggest = ev.content // reply suggestions from the server
        if (ev.type === 'fit.simas.inbox.plan') room.plan = ev.content // a plan agreed in this chat (server/suggest)
        if (ev.type === 'fit.simas.inbox.transcripts') room.transcripts = ev.content // voice messages as text (server/transcribe)
      }
    }
    // This is your own server and only the bridges can invite you, so accept every invite.
    for (const id of Object.keys(res.rooms?.invite || {})) {
      this.api('POST', `/_matrix/client/v3/join/${enc(id)}`, {}).catch(() => {})
    }
    for (const id of Object.keys(res.rooms?.leave || {})) {
      if (this.rooms[id]) this.rooms[id].membership = 'leave'
    }
    this.emit()
  }

  applyState(room, ev) {
    const c = ev.content || {}
    switch (ev.type) {
      case 'm.room.name': room.name = c.name || null; break
      case 'm.room.avatar': room.avatarUrl = c.url || null; break
      case 'm.room.topic': room.topic = c.topic || null; break
      case 'com.beeper.room_features': room.features = c; break
      case 'com.beeper.disappearing_timer': room.disappearing = c.timer ? c : null; break
      case 'm.room.power_levels': room.power = { users: c.users || {}, users_default: c.users_default, invite: c.invite, kick: c.kick, events: c.events || {}, state_default: c.state_default }; break
      case 'm.room.create': room.createTs = ev.origin_server_ts || 0; room.roomType = c.type || null; break
      case 'm.bridge':
        room.bridge = { ...c, stateKey: ev.state_key }
        break
      case 'uk.half-shot.bridge':
        if (!room.bridge) room.bridge = { ...c, stateKey: ev.state_key }
        break
      case 'm.room.member':
        room.members[ev.state_key] = { displayname: c.displayname, avatarUrl: c.avatar_url, membership: c.membership }
        break
    }
  }

  // returns true if this was an event we hadn't seen
  addEvent(room, ev) {
    if (ev.type === VIEWING_TYPE) return // Inbox's own "chat open" signal for the WhatsApp bridge
    const txn = ev.unsigned?.transaction_id
    if (txn) {
      const echo = room.byId[txn]
      if (echo) {
        room.timeline = room.timeline.filter((e) => e !== echo)
        delete room.byId[txn]
      }
    }
    if (room.byId[ev.event_id]) return false
    room.byId[ev.event_id] = ev
    // insert sorted (almost always at the end)
    const t = room.timeline
    let i = t.length
    while (i > 0 && (t[i - 1].origin_server_ts || 0) > (ev.origin_server_ts || 0)) i--
    t.splice(i, 0, ev)
    if (ev.type === 'm.room.redaction' && room.byId[ev.redacts]) {
      room.byId[ev.redacts] = { ...room.byId[ev.redacts], redacted: true }
      room.timeline = room.timeline.map((e) => (e.event_id === ev.redacts ? room.byId[ev.redacts] : e))
    }
    return true
  }

  async paginate(roomId, limit = 30) {
    const room = this.rooms[roomId]
    if (!room || room.reachedStart || room.paginating) return
    room.paginating = true
    try {
      const query = { dir: 'b', limit: String(limit), filter: JSON.stringify({ lazy_load_members: true }) }
      if (room.prevBatch) query.from = room.prevBatch
      const res = await this.api('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/messages`, null, { query })
      for (const ev of res.state || []) this.applyState(room, ev)
      for (const ev of res.chunk || []) {
        if (ev.type === 'm.room.member') this.applyState(room, ev)
        this.addEvent(room, ev)
      }
      room.prevBatch = res.end || null
      if (!res.end || !(res.chunk || []).length) room.reachedStart = true
    } finally {
      room.paginating = false
      this.emit()
    }
  }

  async loadMembers(roomId) {
    const room = this.rooms[roomId]
    if (!room || room.membersLoaded) return
    room.membersLoaded = true
    try {
      const res = await this.api('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`)
      for (const [uid, m] of Object.entries(res.joined || {})) {
        room.members[uid] = { ...room.members[uid], displayname: m.display_name, avatarUrl: m.avatar_url, membership: 'join' }
      }
      this.emit()
    } catch { room.membersLoaded = false }
  }

  // Power levels and the description, which an older cached copy of the room may not have.
  async loadGroupState(roomId) {
    const room = this.rooms[roomId]
    if (!room) return
    for (const type of ['m.room.power_levels', 'm.room.topic']) {
      try {
        const c = await this.api('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/state/${type}`)
        this.applyState(room, { type, state_key: '', content: c })
      } catch {}
    }
    this.emit()
  }

  // What the app allows in this chat (editing etc.), for rooms cached before we kept it.
  async loadFeatures(roomId) {
    const room = this.rooms[roomId]
    if (!room || room.featuresTried) return
    room.featuresTried = true
    // the bridges file room_features under their own state key (e.g. "matrix.simas.fit/whatsapp"),
    // so read the room's state and pick it out
    try {
      const st = await this.api('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/state`)
      for (const ev of st || []) {
        if (ev.type === 'com.beeper.room_features' || ev.type === 'com.beeper.disappearing_timer' || ev.type === 'm.room.power_levels' || ev.type === 'm.room.topic') this.applyState(room, ev)
      }
      if (room.features === undefined) room.features = null
      this.emit()
    } catch { room.featuresTried = false }
  }


  // Edit one of your messages (the bridge changes it in the app too).
  edit(roomId, eventId, body) {
    return this.send(roomId, {
      msgtype: 'm.text', body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    })
  }

  // --- what the apps can do, through the bridges (see room.features) ---

  // Ask sky to transcribe a voice message (an older one, or again if the text was poor)
  async requestTranscript(roomId, eventId, again = false) {
    const room = this.rooms[roomId]
    const path = `/_matrix/client/v3/user/${enc(this.userId)}/rooms/${enc(roomId)}/account_data/fit.simas.inbox.transcripts`
    let doc = {}
    try { doc = await this.api('GET', path) } catch {}
    doc.t = { ...(doc.t || {}) }
    doc.t[eventId] = { ...(doc.t[eventId] || {}), pending: true, ...(again ? { redo: true } : {}), at: Date.now() }
    doc.requests = [...new Set([...(doc.requests || []), eventId])]
    if (room) { room.transcripts = doc; this.emit() }
    await this.api('PUT', path, doc)
  }

  // Delete for everyone ("unsend")
  async redact(roomId, eventId) {
    const room = this.rooms[roomId]
    const ev = room?.byId[eventId]
    if (ev) { ev.unsigned = { ...(ev.unsigned || {}), redacted_because: { local: true } }; this.emit() }
    await this.api('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(eventId)}/${txnId()}`, {})
  }

  // Forward a message to another chat (photos and files go as they are, no re-upload)
  forward(ev, toRoomId) {
    const c = { ...(ev.content || {}) }
    delete c['m.relates_to']; delete c['m.new_content']; delete c['m.mentions']
    if (c.body && c.msgtype === 'm.text') c.body = stripQuote(c.body)
    if (c.formatted_body) c.formatted_body = c.formatted_body.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/g, '')
    return this.send(toRoomId, c, ev.type === 'm.sticker' ? 'm.sticker' : 'm.room.message')
  }

  sendPoll(roomId, question, answers, maxSelections = 1) {
    const list = answers.map((text, i) => ({ id: `o${i + 1}`, 'org.matrix.msc1767.text': text }))
    const fallback = `${question}\n${answers.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    return this.send(roomId, {
      'org.matrix.msc3381.poll.start': { kind: 'org.matrix.msc3381.poll.disclosed', max_selections: maxSelections, question: { 'org.matrix.msc1767.text': question }, answers: list },
      'org.matrix.msc1767.text': fallback, body: fallback,
    }, 'org.matrix.msc3381.poll.start')
  }

  vote(roomId, pollId, answerIds) {
    return this.send(roomId, { 'm.relates_to': { rel_type: 'm.reference', event_id: pollId }, 'org.matrix.msc3381.poll.response': { answers: answerIds } }, 'org.matrix.msc3381.poll.response')
  }

  sendLocation(roomId, lat, lon, accuracy) {
    const geo = `geo:${lat.toFixed(6)},${lon.toFixed(6)}${accuracy ? `;u=${Math.round(accuracy)}` : ''}`
    return this.send(roomId, { msgtype: 'm.location', body: 'Location', geo_uri: geo })
  }

  // Disappearing messages: ms = 0 turns them off
  setDisappearing(roomId, ms) {
    return this.setRoomState(roomId, 'com.beeper.disappearing_timer', ms ? { type: 'after_send', timer: ms } : {})
  }

  async setRoomAvatar(roomId, file) {
    const url = await this.upload(file)
    await this.setRoomState(roomId, 'm.room.avatar', { url })
  }

  // Message requests (Messenger / Instagram): accept, or delete
  acceptRequest(roomId) { return this.send(roomId, {}, 'com.beeper.accept_message_request') }

  blockUser(roomId, block) {
    const room = this.rooms[roomId]
    if (room?.bridge?.channel) { room.bridge.channel['com.beeper.user_blocked'] = block; this.emit() }
    return this.send(roomId, { block }, 'com.beeper.block_user')
  }

  // Delete the chat in the app (Telegram can also delete it for the other person); the
  // bridge then removes the room.
  async deleteChat(roomId, { forEveryone = false, fromRequest = false } = {}) {
    await this.send(roomId, { ...(forEveryone ? { delete_for_everyone: true } : {}), ...(fromRequest ? { from_message_request: true } : {}) }, 'com.beeper.delete_chat')
    if (this.rooms[roomId]) this.rooms[roomId].membership = 'leave'
    this.emit()
  }

  // --- groups: the bridge carries these to the app (add / remove people, rename, leave) ---
  invite(roomId, userId) {
    return this.api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/invite`, { user_id: userId })
  }
  kick(roomId, userId) {
    return this.api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/kick`, { user_id: userId })
  }
  async leave(roomId) {
    await this.api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/leave`, {})
    if (this.rooms[roomId]) this.rooms[roomId].membership = 'leave'
    this.emit()
  }
  async setRoomState(roomId, type, content) {
    await this.api('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/state/${type}/`, content)
    const room = this.rooms[roomId]
    if (room) { this.applyState(room, { type, state_key: '', content }); this.emit() }
  }

  // Resolves when a room appears in sync and test(room) holds (or null after the timeout).
  waitFor(test, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const check = () => { const r = Object.values(this.rooms).find((x) => x.membership === 'join' && test(x)); if (r) { done(); resolve(r) } }
      const done = () => { this.listeners.delete(check); clearTimeout(t) }
      const t = setTimeout(() => { done(); resolve(null) }, timeoutMs)
      this.listeners.add(check)
      check()
    })
  }

  // --- sending ---
  // Tell the WhatsApp bridge this chat is open (or closed), so it shows you online on
  // WhatsApp and WhatsApp sends typing. No local echo; never shown in chats.
  viewing(roomId, on) {
    return this.api('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${VIEWING_TYPE}/${txnId()}`, { viewing: on }).catch(() => {})
  }

  async send(roomId, content, type = 'm.room.message') {
    const room = this.rooms[roomId]
    const id = txnId()
    const echo = {
      event_id: id, local: true, status: 'sending', type, sender: this.userId,
      content, origin_server_ts: Date.now(), room_id: roomId,
    }
    this.addEvent(room, echo)
    this.emit()
    try {
      const res = await this.api('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${type}/${id}`, content)
      if (room.byId[id]) { room.byId[id].status = 'sent'; room.byId[id].realId = res.event_id }
      this.emit()
      return res.event_id
    } catch (e) {
      if (room.byId[id]) room.byId[id].status = 'failed'
      this.emit()
      throw e
    }
  }

  async retry(roomId, echoId) {
    const room = this.rooms[roomId]
    const ev = room?.byId[echoId]
    if (!ev) return
    room.timeline = room.timeline.filter((e) => e !== ev)
    delete room.byId[echoId]
    return this.send(roomId, ev.content, ev.type)
  }

  async upload(file) {
    const res = await this.api('POST', '/_matrix/media/v3/upload', null, {
      query: { filename: file.name || 'file' }, raw: file, contentType: file.type || 'application/octet-stream',
    })
    return res.content_uri
  }

  // caption: text sent with the photo/file (shown under it, like WhatsApp)
  async sendFile(roomId, file, caption = '') {
    // iPhone photos are HEIC, which WhatsApp (and sky's previews) can't take: send a JPEG
    if (isHeic(file)) file = await heicToJpeg(file).catch(() => file)
    const url = await this.upload(file)
    const info = { mimetype: file.type, size: file.size }
    let msgtype = 'm.file'
    if (file.type.startsWith('image/')) {
      msgtype = 'm.image'
      const dims = await imageSize(file).catch(() => null)
      if (dims) Object.assign(info, dims)
    } else if (file.type.startsWith('video/')) msgtype = 'm.video'
    else if (file.type.startsWith('audio/')) msgtype = 'm.audio'
    const content = { msgtype, body: caption || file.name || 'file', url, info }
    if (caption) content.filename = file.name || 'file'
    return this.send(roomId, content)
  }

  // While a chat is open on screen, its messages shouldn't notify you (they'd
  // cover the chat). A server-side push rule per room, removed again when you
  // leave the chat or the app goes to the background; leftovers (app killed)
  // are cleaned up on the next start.
  // Chats you're reading right now on this device: the service worker shows no
  // notification for them here. (It used to be a server push rule, which also
  // silenced the phone while a chat sat open on the Mac.)
  quietRooms(roomIds) {
    const key = roomIds.join('|')
    if (key === this.quietKey && Date.now() - (this.quietAt || 0) < 20_000) return
    this.quietKey = key
    this.quietAt = Date.now()
    idbSet('quietRooms', { rooms: roomIds, at: Date.now() }).catch(() => {})
    // Tell the server too (server/readsync turns it into a "don't notify" rule for these chats
    // on every device, and drops it if this stops being renewed, e.g. the Mac went to sleep).
    const until = roomIds.length ? Date.now() + ACTIVE_FOR_MS : 0
    this.api('PUT', `/_matrix/client/v3/user/${enc(this.userId)}/account_data/${ACTIVE_TYPE}.${enc(this.deviceId)}`,
      { rooms: roomIds, until }, { keepalive: true }).catch(() => {})
  }

  // Remove the old "chat is open" push rules, left by any device's older app version.
  async dropOpenChatRules() {
    try {
      const rules = await this.api('GET', '/_matrix/client/v3/pushrules/')
      for (const r of rules.global?.override || []) {
        if (r.rule_id.startsWith('inbox-open-')) await this.api('DELETE', `/_matrix/client/v3/pushrules/global/override/${enc(r.rule_id)}`).catch(() => {})
      }
    } catch {}
    try { localStorage.removeItem('inbox.quietRooms') } catch {}
  }


  async sendVoice(roomId, blob, durationMs) {
    let type = (blob.type || 'audio/webm').split(';')[0]
    // WebM → Ogg (same Opus audio): the format WhatsApp needs for voice notes
    if (type === 'audio/webm') {
      try { blob = webmOpusToOgg(await blob.arrayBuffer()); type = 'audio/ogg' } catch (e) { console.warn('voice: could not re-wrap as Ogg', e) }
    }
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
    const file = new File([blob], `Voice message.${ext}`, { type })
    const url = await this.upload(file)
    return this.send(roomId, {
      msgtype: 'm.audio', body: file.name, filename: file.name, url, // body = filename, or bridges send it as a separate caption text
      info: { mimetype: type === 'audio/ogg' ? 'audio/ogg; codecs=opus' : type, size: file.size, duration: Math.round(durationMs) },
      'org.matrix.msc1767.audio': { duration: Math.round(durationMs) },
      'org.matrix.msc3245.voice': {},
    })
  }

  react(roomId, eventId, key) {
    return this.send(roomId, { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } }, 'm.reaction')
  }

  typing(roomId, on) {
    return this.api('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(this.userId)}`,
      on ? { typing: true, timeout: 6000 } : { typing: false }).catch(() => {})
  }

  // Mute a chat in Inbox (no notifications, grey unread count): a room push rule that
  // doesn't notify, the same kind the bridges create for chats muted on the phone.
  async setMuted(roomId, muted) {
    const path = `/_matrix/client/v3/pushrules/global/room/${enc(roomId)}`
    if (muted) await this.api('PUT', path, { actions: [] })
    else await this.api('DELETE', path).catch(() => {})
    const g = (this.accountData['m.push_rules'] ||= { global: {} }).global
    g.room = (g.room || []).filter((r) => r.rule_id !== roomId)
    if (muted) g.room.push({ rule_id: roomId, actions: [], enabled: true, default: false })
    this.emit()
  }

  // Reactions notify only when they're to your own message (MSC3664 related_event_match,
  // msc3664_enabled on the server). A chat can opt in to all reactions (see allReactions).
  async ensureReactionRule() {
    const want = [
      { kind: 'event_match', key: 'type', pattern: 'm.reaction' },
      { kind: 'im.nheko.msc3664.related_event_match', rel_type: 'm.annotation', key: 'sender', pattern: this.userId },
    ]
    const g = this.accountData['m.push_rules']?.global || {}
    const cur = (g.underride || []).find((r) => r.rule_id === REACTION_RULE)
    if (cur && JSON.stringify(cur.conditions) === JSON.stringify(want) && cur.enabled !== false) return
    await this.api('PUT', `/_matrix/client/v3/pushrules/global/underride/${REACTION_RULE}`, { conditions: want, actions: ['notify'] }).catch(() => {})
    await this.api('PUT', '/_matrix/client/v3/pushrules/global/override/.m.rule.reaction/enabled', { enabled: false }).catch(() => {})
  }

  allReactions(roomId) {
    const g = this.accountData['m.push_rules']?.global || {}
    return (g.underride || []).some((r) => r.rule_id === allReactionsRule(roomId) && r.enabled !== false)
  }

  async setAllReactions(roomId, on) {
    const id = allReactionsRule(roomId)
    const path = `/_matrix/client/v3/pushrules/global/underride/${enc(id)}`
    const rule = { conditions: [{ kind: 'event_match', key: 'room_id', pattern: roomId }, { kind: 'event_match', key: 'type', pattern: 'm.reaction' }], actions: ['notify'] }
    if (on) await this.api('PUT', path, rule, { query: { before: REACTION_RULE } })
    else await this.api('DELETE', path).catch(() => {})
    const g = (this.accountData['m.push_rules'] ||= { global: {} }).global
    g.underride = (g.underride || []).filter((r) => r.rule_id !== id)
    if (on) g.underride.unshift({ rule_id: id, ...rule, enabled: true, default: false })
    this.emit()
  }

  async setRoomAccountData(roomId, type, content) {
    const room = this.rooms[roomId]
    if (room && type === 'fit.simas.inbox.plan') room.plan = content
    this.emit()
    await this.api('PUT', `/_matrix/client/v3/user/${enc(this.userId)}/rooms/${enc(roomId)}/account_data/${type}`, content).catch(() => {})
  }

  // "Mark as unread" (a dot on the chat until you open it); the bridges pass it on
  // to WhatsApp / Messenger where they can.
  async setMarkedUnread(roomId, unread) {
    const room = this.rooms[roomId]
    if (!room) return
    room.markedUnread = unread
    this.emit()
    await this.api('PUT', `/_matrix/client/v3/user/${enc(this.userId)}/rooms/${enc(roomId)}/account_data/m.marked_unread`, { unread }).catch(() => {})
  }

  async markRead(roomId) {
    const room = this.rooms[roomId]
    const last = [...(room?.timeline || [])].reverse().find((e) => !e.local)
    if (room?.markedUnread) this.setMarkedUnread(roomId, false)
    if (!last || (room.receipts[this.userId] === last.event_id && !room.notificationCount)) return
    room.receipts[this.userId] = last.event_id
    room.notificationCount = 0
    room.unreadCount = 0
    this.emit()
    this.onRead?.(roomId)
    await this.api('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/read_markers`, {
      'm.fully_read': last.event_id, 'm.read': last.event_id,
    }).catch(() => {})
  }

  async setAccountData(type, content) {
    this.accountData[type] = content
    this.emit()
    await this.api('PUT', `/_matrix/client/v3/user/${enc(this.userId)}/account_data/${type}`, content)
  }

  search(term) {
    return this.api('POST', '/_matrix/client/v3/search', {
      search_categories: { room_events: { search_term: term, order_by: 'recent', keys: ['content.body'] } },
    }).then((r) => r.search_categories?.room_events?.results || [])
  }

  async createDM(userId) {
    const res = await this.api('POST', '/_matrix/client/v3/createRoom', { preset: 'trusted_private_chat', invite: [userId], is_direct: true })
    return res.room_id
  }

  // --- push ---
  setPusher(body) {
    return this.api('POST', '/_matrix/client/v3/pushers/set', body)
  }

  setPushRuleEnabled(kind, ruleId, enabled) {
    return this.api('PUT', `/_matrix/client/v3/pushrules/global/${kind}/${enc(ruleId)}/enabled`, { enabled })
  }

  logout() {
    this.stop()
    this.clearCache()
    return this.api('POST', '/_matrix/client/v3/logout', {}).catch(() => {})
  }

  // --- media (authenticated media: needs the token, so fetch into blob URLs) ---
  mediaCached(mxc, { width, download } = {}) {
    return this.mediaDone?.get(`${mxc}|${width || ''}|${download ? 'd' : ''}`) || null
  }

  mediaUrl(mxc, { width, height, download } = {}) {
    if (!mxc?.startsWith('mxc://')) return null
    const key = `${mxc}|${width || ''}|${download ? 'd' : ''}`
    if (this.media.has(key)) return this.media.get(key)
    const [server, id] = mxc.slice(6).split('/')
    const path = width && !download
      ? `/_matrix/client/v1/media/thumbnail/${enc(server)}/${enc(id)}?width=${width}&height=${height || width}&method=scale`
      : `/_matrix/client/v1/media/download/${enc(server)}/${enc(id)}`
    const p = fetch(this.baseUrl + path, { headers: { Authorization: `Bearer ${this.token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((b) => { const u = URL.createObjectURL(b); this.mediaDone.set(key, u); return u })
      .catch((e) => { this.media.delete(key); throw e })
    this.media.set(key, p)
    return p
  }
}

function stripQuote(body) {
  if (!body.startsWith('> ')) return body
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i].startsWith('>')) i++
  return lines.slice(lines[i] === '' ? i + 1 : i).join('\n')
}

export function isMessage(ev) {
  return (ev.type === 'm.room.message' || ev.type === 'm.sticker') && !isEdit(ev)
}
export function isEdit(ev) {
  return ev.content?.['m.relates_to']?.rel_type === 'm.replace'
}

const enc = encodeURIComponent
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isHeic(file) {
  return /^image\/hei[cf]/i.test(file.type || '') || (!file.type && /\.hei[cf]$/i.test(file.name || ''))
}

// Decode a HEIC photo (Safari / the iPhone can) and re-encode it as JPEG, at most 4096 px on
// the long side (iOS canvases refuse very large images; it's also quicker to send).
async function heicToJpeg(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.88))
    return new File([blob], (file.name || 'photo').replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg' })
  } finally { URL.revokeObjectURL(url) }
}

function imageSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(img.src) }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}
