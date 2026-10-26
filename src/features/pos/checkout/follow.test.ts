import { describe, expect, it } from 'vitest'
import type { BillTotals } from './bill'
import { BILL_CHANGED, billChangedAtPay, PAID_ELSEWHERE, VOIDED_ELSEWHERE, followBill, parseCheckoutState, type CheckoutState } from './follow'

const totals = (totalSen: number): BillTotals => ({
  subtotalSen: totalSen, serviceChargeSen: 0, sstSen: 0, takeawayFeeSen: 0, beforeRoundingSen: totalSen,
  roundingSen: 0, totalSen, sstGroups: [], serviceChargeGroups: [],
})
const result = { billId: 'b-1', billNo: '261025-001', totalSen: 7600, changeSen: 400, receiptQueued: true }
const state = (s: Partial<CheckoutState>): CheckoutState => ({
  status: 'open', billNo: '261025-001', mergedIntoBillNo: null, totals: null, result: null, ...s,
})

describe('followBill — the checkout sheet follows its bill', () => {
  it('shows the result when this sheet paid the bill (its reply was lost or came later)', () => {
    expect(followBill(state({ status: 'paid', result }), 7600)).toEqual({ kind: 'paidHere', result })
  })
  it('locks when another iPad paid, voided or merged the bill', () => {
    expect(followBill(state({ status: 'paid' }), 7600)).toEqual({ kind: 'lock', note: PAID_ELSEWHERE })
    expect(PAID_ELSEWHERE).toBe('This bill was paid on another iPad — do not charge the card terminal.')
    expect(followBill(state({ status: 'voided' }), 7600)).toEqual({ kind: 'lock', note: VOIDED_ELSEWHERE })
    expect(VOIDED_ELSEWHERE).toBe('This bill was voided on another iPad.')
    expect(followBill(state({ status: 'merged', mergedIntoBillNo: '261025-007' }), 7600))
      .toEqual({ kind: 'lock', note: 'This bill was merged into 261025-007 on another iPad.' })
  })
  it('loads the totals the first time without a note', () => {
    expect(followBill(state({ totals: totals(7600) }), null)).toEqual({ kind: 'reload', totals: totals(7600), note: null })
  })
  it('reloads with a note when the total changed on another iPad', () => {
    expect(followBill(state({ totals: totals(5000) }), 7600)).toEqual({ kind: 'reload', totals: totals(5000), note: BILL_CHANGED })
    expect(BILL_CHANGED).toBe('The bill changed on another iPad — check the total.')
  })
  it('keeps everything when the total is the same', () => {
    expect(followBill(state({ totals: totals(7600) }), 7600)).toEqual({ kind: 'keep' })
  })
})

describe('parseCheckoutState', () => {
  it('reads the server answer', () => {
    const raw = { status: 'paid', billNo: '261025-001', mergedIntoBillNo: null, totals: null, result }
    expect(parseCheckoutState(raw)).toEqual(raw)
    const open = { status: 'open', billNo: '261025-002', mergedIntoBillNo: null, totals: totals(550), result: null }
    expect(parseCheckoutState(open)).toEqual(open)
  })
  it('refuses anything else', () => {
    for (const bad of [null, [], { status: 'gone', billNo: 'x', mergedIntoBillNo: null, totals: null, result: null },
      { status: 'open', billNo: 'x', totals: null, result: null },
      { status: 'paid', billNo: 'x', mergedIntoBillNo: null, totals: null, result: { billId: 'b' } }]) {
      expect(() => parseCheckoutState(bad)).toThrow('Unexpected reply from the server')
    }
  })
})

describe('billChangedAtPay', () => {
  it('Pay cleared what was entered for the old total: check the new total, enter it again, tap Pay', () => {
    expect(billChangedAtPay({ kind: 'cash', needsReference: false }))
      .toBe('The bill changed on another iPad — check the new total, enter the cash received again, then tap Pay.')
    expect(billChangedAtPay({ kind: 'card', needsReference: true }))
      .toBe('The bill changed on another iPad — check the new total, enter the reference again, then tap Pay.')
    expect(billChangedAtPay({ kind: 'card', needsReference: false }))
      .toBe('The bill changed on another iPad — check the new total, then tap Pay again.')
    expect(billChangedAtPay(null)).toBe('The bill changed on another iPad — check the new total, then tap Pay again.')
  })
})
