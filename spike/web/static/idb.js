// A tiny IndexedDB key-value store: the offline cache and the outbound queue.
const DB = "hohe-spike";
const STORE = "kv";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const kv = {
  get: (key) => tx("readonly", (s) => s.get(key)),
  set: (key, value) => tx("readwrite", (s) => s.put(value, key)),
  clear: () => tx("readwrite", (s) => s.clear()),
};
