// Check bill is pressed exactly when the network is bad, and it disables every exit while it is
// out — so pos_checkout_state must time out like checkout_bill does (hardening review, Task 5).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const h = vi.hoisted(() => {
  const calls: { fn: string; signal: AbortSignal | undefined }[] = []
  const state = { reply: { data: null as unknown, error: null as { message: string } | null } }
  const rpc = (fn: string) => ({
    abortSignal: (signal: AbortSignal) => { calls.push({ fn, signal }); return Promise.resolve(state.reply) },
  })
  return { calls, state, rpc }
})
vi.mock('../../../shared/lib/supabase', () => ({ supabase: { rpc: h.rpc } }))

import { checkoutBill, fetchCheckoutState } from './checkoutApi'
import { looksOffline } from './rpcResult'

const OPEN = { status: 'open', billNo: 'B-1', mergedIntoBillNo: null, totals: { totalSen: 1000 }, result: null }

describe('checkout RPC timeouts', () => {
  let timeout: MockInstance<typeof AbortSignal.timeout>
  beforeEach(() => {
    h.calls.length = 0
    h.state.reply = { data: OPEN, error: null }
    timeout = vi.spyOn(AbortSignal, 'timeout')
  })
  afterEach(() => timeout.mockRestore())

  it('fetchCheckoutState sends a timeout signal — the same 10 s as checkoutBill', async () => {
    await fetchCheckoutState('bill-1', ['id-1'])
    h.state.reply = { data: { billId: 'b', billNo: 'B-1', totalSen: 1, changeSen: 0, receiptQueued: true }, error: null }
    await checkoutBill('bill-1', [], 'id-1')
    expect(h.calls.map((c) => c.fn)).toEqual(['pos_checkout_state', 'checkout_bill'])
    expect(h.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([10_000, 10_000])
  })

  it('a timeout reaches the sheet as an error the sheet recognises as no reply', async () => {
    h.state.reply = { data: null, error: { message: 'TimeoutError: The operation was aborted due to timeout' } }
    const err = await fetchCheckoutState('bill-1', ['id-1']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(looksOffline((err as Error).message)).toBe(true)
  })
})
