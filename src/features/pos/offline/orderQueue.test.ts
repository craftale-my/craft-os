import { describe, it, expect, vi } from 'vitest'
import {
  flushQueue, newQueuedOrder, enqueue, toSendResult,
  type QueueStore, type QueuedOrder, type SendResult,
} from './orderQueue'

function memoryStore(): QueueStore & { rows: Map<string, QueuedOrder> } {
  const rows = new Map<string, QueuedOrder>()
  return {
    rows,
    put: async (o) => void rows.set(o.clientOrderId, o),
    all: async () => [...rows.values()],
    remove: async (id) => void rows.delete(id),
  }
}

const line = { menuItemId: 'm1', qty: 1, note: null }
const ok: SendResult = { ok: true }

describe('flushQueue', () => {
  it('sends oldest first and empties the queue', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 2000, 'b'))
    await enqueue(store, newQueuedOrder(null, [line], 1000, 'a'))
    const send = vi.fn(async (_o: QueuedOrder) => ok)
    expect(await flushQueue(store, send)).toEqual({ sent: 2, pending: 0, stuck: 0 })
    expect(send.mock.calls.map(([o]) => o.clientOrderId)).toEqual(['a', 'b'])
  })

  it('stops at a network failure and keeps that order and everything after it', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 1, 'a'))
    await enqueue(store, newQueuedOrder(null, [line], 2, 'b'))
    const send = vi.fn(async () => ({ ok: false, retryable: true, reason: 'Load failed' }) as SendResult)
    expect(await flushQueue(store, send)).toEqual({ sent: 0, pending: 2, stuck: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('parks an order the server rejected and carries on with the rest', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 1, 'bad'))
    await enqueue(store, newQueuedOrder(null, [line], 2, 'good'))
    const send = vi.fn(async (o: QueuedOrder) =>
      o.clientOrderId === 'bad' ? ({ ok: false, retryable: false, reason: 'Item is not available' } as SendResult) : ok,
    )
    expect(await flushQueue(store, send)).toEqual({ sent: 1, pending: 0, stuck: 1 })
    expect(store.rows.get('bad')?.failedReason).toBe('Item is not available')
  })

  it('never resends a parked order', async () => {
    const store = memoryStore()
    await store.put({ ...newQueuedOrder(null, [line], 1, 'bad'), failedReason: 'Item is not available' })
    const send = vi.fn(async () => ok)
    await flushQueue(store, send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('newQueuedOrder', () => {
  it('copies the cart so later cart edits cannot change a queued order', () => {
    const items = [{ ...line }]
    const order = newQueuedOrder('t1', items, 5, 'id')
    items[0].qty = 9
    expect(order).toEqual({ clientOrderId: 'id', tableId: 't1', items: [line], queuedAt: 5, failedReason: null })
  })
})

describe('toSendResult', () => {
  it('treats no error as success', () => {
    expect(toSendResult(null)).toEqual({ ok: true })
  })

  it.each(['TypeError: Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed'])(
    'treats "%s" as a retryable network failure',
    (message) => {
      expect(toSendResult({ message })).toEqual({ ok: false, retryable: true, reason: message })
    },
  )

  it('treats database errors as final', () => {
    expect(toSendResult({ message: 'Item is not available: x' })).toEqual({
      ok: false, retryable: false, reason: 'Item is not available: x',
    })
  })
})
