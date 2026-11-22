// Re-wrap an Opus recording from WebM (what Chrome and iPhone Safari record)
// into Ogg — the only voice-note format WhatsApp accepts, and fine for
// Telegram/Messenger/Instagram. The audio itself is untouched (no re-encoding).

const ID = {
  Segment: 0x18538067, Cluster: 0x1f43b675, Tracks: 0x1654ae6b, TrackEntry: 0xae, Audio: 0xe1,
  BlockGroup: 0xa0, Block: 0xa1, SimpleBlock: 0xa3, CodecPrivate: 0x63a2, Channels: 0x9f, CodecID: 0x86,
}
const MASTER = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.Audio, ID.BlockGroup])

function vint(b, pos, keepMarker) {
  const first = b[pos]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8) throw new Error('bad EBML')
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = (first & (0xff >> len)) === 0xff >> len
  for (let i = 1; i < len; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xff) allOnes = false }
  return { value, len, unknown: !keepMarker && allOnes }
}

// Walk the WebM and collect the Opus packets (+ the OpusHead header if present).
export function readWebmOpus(buf) {
  const b = new Uint8Array(buf)
  const packets = []
  let head = null
  let codec = null
  let channels = 1
  function walk(start, end) {
    let pos = start
    while (pos < end && pos < b.length) {
      const id = vint(b, pos, true)
      const size = vint(b, pos + id.len, false)
      const dataStart = pos + id.len + size.len
      const dataEnd = size.unknown ? end : Math.min(dataStart + size.value, b.length)
      if (MASTER.has(id.value)) {
        walk(dataStart, dataEnd)
      } else if (id.value === ID.SimpleBlock || id.value === ID.Block) {
        const track = vint(b, dataStart, false)
        const flags = b[dataStart + track.len + 2]
        if ((flags & 0x06) === 0) packets.push(b.slice(dataStart + track.len + 3, dataEnd))
      } else if (id.value === ID.CodecPrivate) {
        head = b.slice(dataStart, dataEnd)
      } else if (id.value === ID.CodecID) {
        codec = new TextDecoder().decode(b.slice(dataStart, dataEnd))
      } else if (id.value === ID.Channels) {
        channels = b[dataEnd - 1] || 1
      }
      // unknown-size elements (live recordings) run to the end of their parent
      pos = size.unknown && !MASTER.has(id.value) ? end : dataEnd
    }
  }
  walk(0, b.length)
  if (codec && codec !== 'A_OPUS') throw new Error(`not Opus audio (${codec})`)
  if (!packets.length) throw new Error('no audio in the recording')
  return { packets, head, channels }
}

// Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1).
export function opusSamples(p) {
  const toc = p[0]
  const config = toc >> 3
  const ms = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4]
  const c = toc & 3
  const frames = c === 0 ? 1 : c === 3 ? (p[1] & 0x3f) : 2
  return Math.round(frames * ms * 48)
}

let CRC_TABLE = null
function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let r = i << 24
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
      CRC_TABLE[i] = r >>> 0
    }
  }
  let crc = 0
  for (const x of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ x) & 0xff]) >>> 0
  return crc
}

function page(packets, { granule, serial, seq, bos, eos }) {
  const lacing = []
  for (const p of packets) {
    let n = p.length
    while (n >= 255) { lacing.push(255); n -= 255 }
    lacing.push(n)
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(27 + lacing.length + bodyLen)
  const v = new DataView(out.buffer)
  out.set([0x4f, 0x67, 0x67, 0x53], 0) // "OggS"
  out[5] = (bos ? 2 : 0) | (eos ? 4 : 0)
  v.setUint32(6, granule % 2 ** 32, true)
  v.setUint32(10, Math.floor(granule / 2 ** 32), true)
  v.setUint32(14, serial, true)
  v.setUint32(18, seq, true)
  out[26] = lacing.length
  out.set(lacing, 27)
  let pos = 27 + lacing.length
  for (const p of packets) { out.set(p, pos); pos += p.length }
  v.setUint32(22, crc32(out), true)
  return out
}

function opusHead(channels) {
  const h = new Uint8Array(19)
  h.set(new TextEncoder().encode('OpusHead'), 0)
  const v = new DataView(h.buffer)
  h[8] = 1
  h[9] = channels
  v.setUint16(10, 312, true) // pre-skip
  v.setUint32(12, 48000, true)
  return h
}

function opusTags() {
  const vendor = new TextEncoder().encode('Inbox')
  const t = new Uint8Array(8 + 4 + vendor.length + 4)
  t.set(new TextEncoder().encode('OpusTags'), 0)
  new DataView(t.buffer).setUint32(8, vendor.length, true)
  t.set(vendor, 12)
  return t
}

export function webmOpusToOgg(buf) {
  const { packets, head, channels } = readWebmOpus(buf)
  const serial = (Math.random() * 2 ** 32) >>> 0
  const pages = [
    page([head && head.length >= 19 ? head : opusHead(channels)], { granule: 0, serial, seq: 0, bos: true }),
    page([opusTags()], { granule: 0, serial, seq: 1 }),
  ]
  let granule = 0
  let seq = 2
  let batch = []
  let segs = 0
  packets.forEach((p, i) => {
    const need = Math.floor(p.length / 255) + 1
    if (batch.length && segs + need > 255) {
      pages.push(page(batch, { granule, serial, seq: seq++ }))
      batch = []
      segs = 0
    }
    batch.push(p)
    segs += need
    granule += opusSamples(p)
    if (i === packets.length - 1) pages.push(page(batch, { granule, serial, seq: seq++, eos: true }))
  })
  return new Blob(pages, { type: 'audio/ogg' })
}
