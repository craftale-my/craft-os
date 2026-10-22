import type { QueueStore, QueuedOrder } from './orderQueue'

const STORE = 'order-queue'

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientOrderId' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Opens, runs one request, and waits for the transaction to COMMIT — only
 *  then is the order on disk. Resolving on the request's onsuccess would be
 *  too early. */
async function run<T>(
  dbName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb(dbName)
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => {
      db.close()
      resolve(req.result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

export function createIdbStore(dbName = 'craft-pos'): QueueStore {
  return {
    put: async (o) => {
      await run(dbName, 'readwrite', (s) => s.put(o))
    },
    all: () => run(dbName, 'readonly', (s) => s.getAll() as IDBRequest<QueuedOrder[]>),
    remove: async (id) => {
      await run(dbName, 'readwrite', (s) => s.delete(id))
    },
  }
}
