import { describe, expect, it } from 'vitest'
import { newQueuedOrder, type QueueStore, type QueuedOrder } from '../features/pos/offline/orderQueue'
import {
  clearPendingLock, forgetContext, holdQueued, loadContext, loadProductNames, pendingLock, saveContext,
  saveProductNames, setPendingLock, UNPAIRED_REASON,
} from './deviceStore'
import type { RosterReply } from './roster'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) },
  }
}
function memoryQueue(): QueueStore {
  const rows = new Map<string, QueuedOrder>()
  return { put: async (o) => void rows.set(o.clientOrderId, o), all: async () => [...rows.values()], remove: async (id) => void rows.delete(id) }
}
const line = { productId: 'p1', variantId: 'v1', qty: 1, note: null, optionIds: [] }
const roster = { device: { id: 'd', name: 'Counter', prints: true } } as RosterReply

describe('deviceStore', () => {
  it('keeps the last context and forgets it on unpair', () => {
    const s = memoryStorage()
    saveContext(s, { roster, who: null })
    setPendingLock(s, 'locked')
    expect(loadContext(s)).toEqual({ roster, who: null })
    forgetContext(s)
    expect(loadContext(s)).toBeNull()
    expect(pendingLock(s)).toBeNull()
  })

  it('remembers a Lock pressed offline until cleared, and ignores junk', () => {
    const s = memoryStorage()
    setPendingLock(s, 'idle')
    expect(pendingLock(s)).toBe('idle')
    clearPendingLock(s)
    expect(pendingLock(s)).toBeNull()
    s.setItem('craft-pos-lock-pending', 'whatever')
    expect(pendingLock(s)).toBeNull()
  })

  it('keeps product names for the unpaired screen', () => {
    const s = memoryStorage()
    expect(loadProductNames(s).size).toBe(0)
    saveProductNames(s, [{ id: 'p1', name: 'Latte' }])
    expect(loadProductNames(s).get('p1')).toBe('Latte')
  })

  it('holds back the waiting orders of an unpaired device, keeping earlier reasons', async () => {
    const q = memoryQueue()
    await q.put(newQueuedOrder('takeaway', null, null, [line], 2, 'b'))
    await q.put({ ...newQueuedOrder('takeaway', null, null, [line], 1, 'a'), failedReason: 'Item is not available' })
    const held = await holdQueued(q)
    expect(held.map((o) => [o.clientOrderId, o.failedReason])).toEqual([['a', 'Item is not available'], ['b', UNPAIRED_REASON]])
  })
})
