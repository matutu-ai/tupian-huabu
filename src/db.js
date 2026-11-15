// Minimal IndexedDB wrapper for projects (images are stored inline as data URLs).
const DB_NAME = 'huabu';
const STORE = 'projects';
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('uid', 'uid');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  put: (p) => tx('readwrite', (s) => s.put(p)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  byUser: (uid) => tx('readonly', (s) => s.index('uid').getAll(uid)),
};
