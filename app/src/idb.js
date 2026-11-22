// Tiny IndexedDB key-value store (database "inbox", store "kv"), shared with
// the service worker. Every call resolves, never throws: if storage isn't
// available the app simply works without it.
let dbPromise = null

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('inbox', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('kv')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      } catch { resolve(null) }
    })
  }
  return dbPromise
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null)
    try {
      const tx = db.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      tx.oncomplete = () => resolve(req?.result ?? null)
      tx.onerror = tx.onabort = () => resolve(null)
    } catch { resolve(null) }
  }))
}

export const idbGet = (key) => run('readonly', (s) => s.get(key))
export const idbSet = (key, value) => run('readwrite', (s) => s.put(value, key))
export const idbDel = (key) => run('readwrite', (s) => s.delete(key))
