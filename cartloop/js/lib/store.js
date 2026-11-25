// 브라우저 저장소(IndexedDB). Loop DB는 이 브라우저 안에만 저장된다.
const NAME = 'cartloop', STORE = 'kv';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const q = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(q?.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}
export const load = key => tx('readonly', s => s.get(key)).catch(() => null);
export const save = (key, value) => tx('readwrite', s => s.put(value, key)).catch(e => console.warn('저장 실패', e));
export const remove = key => tx('readwrite', s => s.delete(key)).catch(() => null);
