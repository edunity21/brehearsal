let database;
export async function db() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const req = indexedDB.open('bridge-rehearsal', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('sessions', { keyPath: 'id' });
      const chunks = req.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
      chunks.createIndex('session', 'id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return database;
}
async function transaction(stores, mode, run) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('저장이 중단되었습니다.'));
    run(tx, value => { result = value; });
  });
}
export const saveSession = session => transaction(['sessions'], 'readwrite', tx => tx.objectStore('sessions').put(session));
export const saveChunk = (id, index, blob) => transaction(['chunks'], 'readwrite', tx => tx.objectStore('chunks').put({ id, index, blob }));
export const listSessions = () => transaction(['sessions'], 'readonly', (tx, done) => {
  tx.objectStore('sessions').getAll().onsuccess = e => done(e.target.result.sort((a,b) => b.created - a.created));
});
export const loadChunks = id => transaction(['chunks'], 'readonly', (tx, done) => {
  tx.objectStore('chunks').index('session').getAll(id).onsuccess = e => done(e.target.result.sort((a,b) => a.index-b.index).map(c => c.blob));
});
export const deleteSession = id => transaction(['sessions', 'chunks'], 'readwrite', tx => {
  tx.objectStore('sessions').delete(id);
  tx.objectStore('chunks').index('session').openCursor(IDBKeyRange.only(id)).onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
});
