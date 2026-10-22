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

const line = { productId: 'p1', variantId: 'v1', qty: 1, note: null, optionIds: [] }
const ok: SendResult = { ok: true }

describe('flushQueue', () => {
  it('sends oldest first and empties the queue', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 2000, 'b'))
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1000, 'a'))
    const send = vi.fn(async (_o: QueuedOrder) => ok)
    expect(await flushQueue(store, send)).toEqual({ sent: 2, pending: 0, stuck: 0, lastError: null })
    expect(send.mock.calls.map(([o]) => o.clientOrderId)).toEqual(['a', 'b'])
  })

  it('stops at a network failure and keeps that order and everything after it', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1, 'a'))
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 2, 'b'))
    const send = vi.fn(async () => ({ ok: false, retryable: true, reason: 'Load failed' }) as SendResult)
    expect(await flushQueue(store, send)).toEqual({ sent: 0, pending: 2, stuck: 0, lastError: 'Load failed' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('parks an order the server rejected and carries on with the rest', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1, 'bad'))
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 2, 'good'))
    const send = vi.fn(async (o: QueuedOrder) =>
      o.clientOrderId === 'bad' ? ({ ok: false, retryable: false, reason: 'Item is not available' } as SendResult) : ok,
    )
    expect(await flushQueue(store, send)).toEqual({ sent: 1, pending: 0, stuck: 1, lastError: null })
    expect(store.rows.get('bad')?.failedReason).toBe('Item is not available')
  })

  it('never resends a parked order', async () => {
    const store = memoryStore()
    await store.put({ ...newQueuedOrder('takeaway', null, null, [line], 1, 'bad'), failedReason: 'Item is not available' })
    const send = vi.fn(async () => ok)
    await flushQueue(store, send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('queued order fields', () => {
  it('carries order type, table and pax to the sender', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('dine_in', 't-5', 2, [line], 1, 'a'))
    const seen: QueuedOrder[] = []
    await flushQueue(store, async (o) => { seen.push(o); return { ok: true } })
    expect(seen[0]).toMatchObject({ orderType: 'dine_in', tableId: 't-5', pax: 2, items: [line] })
  })
})

describe('flushQueue with a throwing sender', () => {
  it('keeps the order and stops the flush instead of rejecting', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1, 'a'))
    const send = vi.fn(async () => { throw new Error('boom') })
    expect(await flushQueue(store, send)).toEqual({ sent: 0, pending: 1, stuck: 0, lastError: 'boom' })
  })
})

describe('flushQueue lastError', () => {
  it('reports the reason of the retryable failure that stopped the flush, and null after a clean flush', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1, 'a'))
    const down = vi.fn(async () => ({ ok: false, retryable: true, reason: 'Load failed' }) as SendResult)
    expect((await flushQueue(store, down)).lastError).toBe('Load failed')
    const up = vi.fn(async () => ok)
    expect((await flushQueue(store, up)).lastError).toBeNull()
  })

  it('does not report a final rejection as lastError', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('takeaway', null, null, [line], 1, 'bad'))
    const send = vi.fn(async () => ({ ok: false, retryable: false, reason: 'Item is not available' }) as SendResult)
    expect((await flushQueue(store, send)).lastError).toBeNull()
  })
})

describe('newQueuedOrder', () => {
  it('copies the cart so later cart edits cannot change a queued order', () => {
    const items = [{ ...line }]
    const order = newQueuedOrder('dine_in', 't1', 4, items, 5, 'id')
    items[0].qty = 9
    expect(order).toEqual({ clientOrderId: 'id', orderType: 'dine_in', tableId: 't1', pax: 4, items: [line], queuedAt: 5, failedReason: null })
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

  it('treats the RPC\'s own business-rule rejections as final', () => {
    expect(toSendResult({ message: 'Item is not available: x', code: 'P0001' })).toEqual({
      ok: false, retryable: false, reason: 'Item is not available: x',
    })
  })

  it('treats a check violation as final', () => {
    expect(toSendResult({ message: 'new row violates check constraint', code: '23514' })).toEqual({
      ok: false, retryable: false, reason: 'new row violates check constraint',
    })
  })

  it('retries an expired JWT', () => {
    expect(toSendResult({ message: 'JWT expired', code: 'PGRST301' })).toEqual({
      ok: false, retryable: true, reason: 'JWT expired',
    })
  })

  it('retries a statement timeout', () => {
    expect(toSendResult({ message: 'canceling statement due to statement timeout', code: '57014' })).toEqual({
      ok: false, retryable: true, reason: 'canceling statement due to statement timeout',
    })
  })
})
