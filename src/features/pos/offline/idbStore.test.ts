import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { createIdbStore, runTransaction } from './idbStore'
import { newQueuedOrder, type QueuedOrder } from './orderQueue'

describe('createIdbStore', () => {
  it('keeps orders across separate store instances (i.e. a page reload)', async () => {
    const first = createIdbStore('test-reload')
    await first.put(newQueuedOrder('t1', [{ menuItemId: 'm1', qty: 2, note: 'hot' }], 1, 'a'))
    await first.put(newQueuedOrder(null, [{ menuItemId: 'm2', qty: 1, note: null }], 2, 'b'))

    const second = createIdbStore('test-reload')
    const rows = (await second.all()).sort((x, y) => x.queuedAt - y.queuedAt)
    expect(rows.map((r) => r.clientOrderId)).toEqual(['a', 'b'])
    expect(rows[0].items).toEqual([{ menuItemId: 'm1', qty: 2, note: 'hot' }])
  })

  it('removes and overwrites by clientOrderId', async () => {
    const store = createIdbStore('test-remove')
    const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
    await store.put(order)
    await store.put({ ...order, failedReason: 'rejected' })
    expect(await store.all()).toEqual([{ ...order, failedReason: 'rejected' }])
    await store.remove('a')
    expect(await store.all()).toEqual([])
  })

  describe('never hangs', () => {
    it('rejects a put with no key instead of hanging', async () => {
      const store = createIdbStore('test-nokey')
      await expect(store.put({ foo: 1 } as unknown as QueuedOrder)).rejects.toBeDefined()
    })

    it('rejects when the transaction is aborted', async () => {
      const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
      await expect(
        runTransaction('test-abort', 'readwrite', (s) => {
          const r = s.put(order)
          s.transaction.abort()
          return r
        }),
      ).rejects.toBeDefined()
    })

    it('still works on the same database after a rejected call', async () => {
      const store = createIdbStore('test-after-reject')
      await store.put({ foo: 1 } as unknown as QueuedOrder).catch(() => {})
      const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
      await store.put(order)
      expect(await store.all()).toEqual([order])
    })
  })
})
