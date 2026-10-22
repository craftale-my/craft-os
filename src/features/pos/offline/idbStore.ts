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
 *  too early. Always settles: a commit-time abort (quota, eviction) rejects,
 *  and a synchronous throw closes the connection instead of leaking it. */
export async function runTransaction<T>(
  dbName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb(dbName)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      db.close()
      settle()
    }
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => finish(() => resolve(req.result))
      tx.onerror = () => finish(() => reject(tx.error))
      tx.onabort = () =>
        finish(() => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError')))
    } catch (e) {
      finish(() => reject(e))
    }
  })
}

export function createIdbStore(dbName = 'craft-pos'): QueueStore {
  return {
    put: async (o) => {
      await runTransaction(dbName, 'readwrite', (s) => s.put(o))
    },
    all: () => runTransaction(dbName, 'readonly', (s) => s.getAll() as IDBRequest<QueuedOrder[]>),
    remove: async (id) => {
      await runTransaction(dbName, 'readwrite', (s) => s.delete(id))
    },
  }
}
