// Tiny IndexedDB wrapper for the card's local caches (model blobs). Every call resolves
// (null / [] / false) instead of throwing: private windows, blocked storage or no IndexedDB at all.
const DB = 'floorplan3d';
const STORES = ['snapshots', 'models'];

/** Object store names of the card's database. */
export type IdbStore = 'snapshots' | 'models';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run<T>(store: IdbStore, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null, fallback: T): Promise<T> {
  const db = await open();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      // a read resolves with its result; a write (no request kept) with true
      tx.oncomplete = () => resolve(req ? (req.result as T) ?? fallback : (true as T));
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch (e) {
      resolve(fallback);
    }
  });
}

// Records are whatever the caller stored (keyPath 'key'): typed by the caller, not checked here.
export const idbGet = <T = Record<string, unknown>>(store: IdbStore, key: IDBValidKey): Promise<T | null> =>
  run<T | null>(store, 'readonly', (s) => s.get(key), null);
export const idbAll = <T = Record<string, unknown>>(store: IdbStore): Promise<T[]> => run<T[]>(store, 'readonly', (s) => s.getAll(), []);
export const idbPut = (store: IdbStore, value: { key: IDBValidKey; [k: string]: unknown }): Promise<boolean> =>
  run<boolean>(store, 'readwrite', (s) => { s.put(value); return null; }, false);
export const idbDelete = (store: IdbStore, keys: IDBValidKey[]): Promise<boolean> =>
  run<boolean>(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); return null; }, false);
