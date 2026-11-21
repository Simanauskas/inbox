// Turns a push from the server (Sygnal's Web Push payload) into a notification.
// Loaded by the service worker with importScripts, and by the unit tests.
;(function (root) {
  function stripReply(body) {
    if (!body || !body.startsWith('> ')) return body || ''
    const lines = body.split('\n')
    let i = 0
    while (i < lines.length && lines[i].startsWith('>')) i++
    if (lines[i] === '') i++
    return lines.slice(i).join('\n')
  }

  function bodyOf(p) {
    const c = p.content || {}
    if (p.type === 'm.room.member') return c.membership === 'invite' ? 'New chat' : ''
    if (p.type === 'm.sticker') return 'Sticker'
    if (p.type === 'm.room.encrypted') return 'New message'
    switch (c.msgtype) {
      case 'm.image': return '📷 Photo'
      case 'm.video': return '🎥 Video'
      case 'm.audio': return c['org.matrix.msc3245.voice'] !== undefined ? '🎤 Voice message' : '🎵 Audio'
      case 'm.file': return '📎 ' + (c.filename || c.body || 'File')
      case 'm.location': return '📍 Location'
      case 'm.emote': return '* ' + (c.body || '')
      default: return stripReply(c.body || '') || 'New message'
    }
  }

  function notificationFromPush(p) {
    const sender = p.sender_display_name || (p.sender ? p.sender.slice(1).split(':')[0] : 'Inbox')
    // bridged DMs are named after the contact; a different room name means a group
    const group = p.room_name && p.room_name !== p.sender_display_name ? p.room_name : null
    return {
      title: group ? `${sender} · ${group}` : sender,
      options: {
        body: bodyOf(p),
        tag: p.room_id || 'inbox',
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { roomId: p.room_id || null, hash: p.room_id ? '#/t/' + encodeURIComponent('r:' + p.room_id) : '' },
      },
    }
  }

  root.InboxPush = { notificationFromPush, bodyOf }
})(typeof self !== 'undefined' ? self : globalThis)
