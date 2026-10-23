import { describe, it, expect } from 'vitest'
import { parseCheckoutResult, parseRefundResult, unwrapAction } from './rpcResult'

describe('unwrapAction', () => {
  it('returns an approved reply', () => {
    expect(unwrapAction({ ok: true, refundedSen: 1300 })).toEqual({ ok: true, refundedSen: 1300 })
  })
  it('throws the server words when refused', () => {
    expect(() => unwrapAction({ ok: false, error: 'Wrong PIN — 4 tries left' })).toThrow('Wrong PIN — 4 tries left')
    expect(() => unwrapAction({ ok: false })).toThrow('Not approved')
  })
  it('throws on anything else', () => {
    expect(() => unwrapAction(null)).toThrow('Unexpected reply')
    expect(() => unwrapAction({ ok: 'yes' })).toThrow('Unexpected reply')
  })
})

describe('parseCheckoutResult', () => {
  it('reads the checkout reply', () => {
    expect(parseCheckoutResult({ billId: 'b1', billNo: '261024-001', totalSen: 9280, changeSen: 0, receiptQueued: true }))
      .toEqual({ billId: 'b1', billNo: '261024-001', totalSen: 9280, changeSen: 0, receiptQueued: true })
  })
  it('refuses a reply with a missing field', () => {
    expect(() => parseCheckoutResult({ billNo: '261024-001', totalSen: 9280 })).toThrow('Unexpected reply')
  })
})

describe('parseRefundResult', () => {
  it('reads what the server recorded', () => {
    expect(parseRefundResult({ ok: true, amountSen: 500, refundedSen: 1300, slipQueued: false }))
      .toEqual({ amountSen: 500, refundedSen: 1300, slipQueued: false })
  })
  it('throws the server words when a resend differs from the recorded refund', () => {
    const error = 'This refund was already recorded as RM 5.00 by Cash — close and reopen to refund more'
    expect(() => parseRefundResult({ ok: false, error })).toThrow(error)
  })
  it('refuses a reply without the recorded amount', () => {
    expect(() => parseRefundResult({ ok: true, refundedSen: 1300, slipQueued: true })).toThrow('Unexpected reply')
  })
})
