import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { createIdbStore } from './idbStore'
import { newQueuedOrder } from './orderQueue'

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
})
