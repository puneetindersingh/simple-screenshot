// Small IndexedDB store shared by the service worker and shot.html.
// A full-page PNG can run to tens of megabytes, which is too big for
// chrome.storage.session, so finished screenshots go through IndexedDB.
self.ShotStore = (() => {
  const DB_NAME = 'simple-screenshot';
  const STORE = 'shots';
  // Older screenshots are dropped from the store; saved files are untouched.
  const KEEP = 10;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, work) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function put(shot) {
    // Date.now() is 13 digits until the year 2286, so ids sort by age.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await run('readwrite', (store) => store.put({ ...shot, id, createdAt: Date.now() }));
    await prune();
    return id;
  }

  function get(id) {
    return run('readonly', (store) => store.get(id));
  }

  async function prune() {
    const ids = await run('readonly', (store) => store.getAllKeys());
    const old = ids.slice(0, Math.max(0, ids.length - KEEP));
    if (old.length) await run('readwrite', (store) => old.forEach((id) => store.delete(id)));
  }

  return { put, get };
})();
