import { describe, expect, it } from 'vitest'
import {
  AMOUNT_OVER_BALANCE, BALANCE_DUE, ENTER_AMOUNT, PERCENT_CHIPS, SHARE_LOADING, SHARE_ZERO, SPLIT_MODE_LABEL, clampWays, equalPay, fixedWays,
  paidPartLabel, parseBillParts, parsePartQuote, parsePartResult, partPaidNote, partPaidTag, partProblem, payLabelFor, percentChipSen,
  shareLabel, splitIntoLabel, type BillPart, type PartQuote,
} from './partSplit'

const parts: BillPart[] = [
  { id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] },
  { id: 'x2', partNo: 2, ways: null, amountSen: 1000, methods: ['Card', 'Cash'] },
  { id: 'x3', partNo: 3, ways: 3, amountSen: 2345, methods: [] },
]

describe('labels (split spec §3.5)', () => {
  it('are the spec words', () => {
    expect(SPLIT_MODE_LABEL).toEqual({ item: 'By item', equal: 'Equally', amount: 'By amount' })
    expect(splitIntoLabel(3)).toBe('Split into 3')
    expect(shareLabel(1, 3, 2345)).toBe('Share 1 of 3 · RM 23.45')
    expect(BALANCE_DUE).toBe('Balance due')
    expect(partPaidTag(2345)).toBe('Part paid · RM 23.45')
    expect(PERCENT_CHIPS).toEqual([25, 33, 50])
  })
  it('a paid part: "Paid k of N" counts equal shares only; a part by amount by its number', () => {
    expect(paidPartLabel(parts[0], parts)).toBe('Paid 1 of 3 · RM 23.45 (Cash)')
    expect(paidPartLabel(parts[1], parts)).toBe('Paid part 2 · RM 10.00 (Card, Cash)')
    expect(paidPartLabel(parts[2], parts)).toBe('Paid 2 of 3 · RM 23.45')
  })
  it('the note after a part is paid', () => {
    expect(partPaidNote({ partNo: 1, amountSen: 2345, changeSen: 2655, paidSen: 2345 })).toBe('Part 1 paid · RM 23.45 · Change RM 26.55')
    expect(partPaidNote({ partNo: 2, amountSen: 1000, changeSen: null, paidSen: 3345 })).toBe('Part 2 paid · RM 10.00')
  })
})

describe('the equal split', () => {
  it('N is 2…20, and fixed by the last equal share paid', () => {
    expect(clampWays(1)).toBe(2)
    expect(clampWays(25)).toBe(20)
    expect(clampWays(4)).toBe(4)
    expect(fixedWays([])).toBeNull()
    expect(fixedWays([parts[1]])).toBeNull()
    expect(fixedWays(parts)).toBe(3)
  })
})

describe('percent chips: of the bill total, down to 5 sen, below the balance', () => {
  it('rounds down to 5 sen', () => {
    expect(percentChipSen(7035, 33, 7035)).toBe(2320)
    expect(percentChipSen(7035, 25, 7035)).toBe(1755)
    expect(percentChipSen(7035, 50, 7035)).toBe(3515)
  })
  it('stays below the balance, or is not offered', () => {
    expect(percentChipSen(7035, 50, 2345)).toBe(2340)
    expect(percentChipSen(100, 25, 5)).toBeNull()
  })
})

describe('partProblem: what Pay checks before a part goes out', () => {
  it('by amount: an amount, not above the balance (equal to it pays the rest)', () => {
    expect(partProblem('amount', null, 7035)).toBe(ENTER_AMOUNT)
    expect(partProblem('amount', 0, 7035)).toBe(ENTER_AMOUNT)
    expect(partProblem('amount', 8000, 7035)).toBe(AMOUNT_OVER_BALANCE)
    expect(AMOUNT_OVER_BALANCE).toBe('The amount is more than the balance')
    expect(partProblem('amount', 7035, 7035)).toBeNull()
    expect(partProblem('amount', 2000, 7035)).toBeNull()
  })
  it('equally: the share must have come', () => {
    expect(partProblem('equal', null, 7035)).toBe(SHARE_LOADING)
    expect(partProblem('equal', 2345, 7035)).toBeNull()
    expect(partProblem('none', null, 7035)).toBeNull()
  })
})

describe('equalPay: what Pay does in Equally, decided from the quote itself', () => {
  const q = (shareSen: number | null, balanceSen: number): PartQuote =>
    ({ totalSen: 7035, paidSen: 7035 - balanceSen, balanceSen, partsPaid: 0, sharesPaid: 0, ways: 3, shareSen })
  it('no quote yet: Pay waits', () => {
    expect(equalPay(null)).toEqual({ kind: 'problem', problem: SHARE_LOADING })
  })
  it('a share below the balance is a part', () => {
    expect(equalPay(q(2345, 7035))).toEqual({ kind: 'part', shareSen: 2345 })
    expect(equalPay(q(2345, 2350))).toEqual({ kind: 'part', shareSen: 2345 })
  })
  it('a share equal to or above the balance is the rest: checkout_bill of the balance', () => {
    expect(equalPay(q(2345, 2345))).toEqual({ kind: 'rest' })
    expect(equalPay(q(2350, 2345))).toEqual({ kind: 'rest' })
    expect(equalPay(q(5, 3))).toEqual({ kind: 'rest' })
  })
  it('a balance of 0 is the rest (no payment); a share of 0 against a balance is a problem', () => {
    expect(equalPay(q(0, 0))).toEqual({ kind: 'rest' })
    expect(equalPay(q(0, 7035))).toEqual({ kind: 'problem', problem: SHARE_ZERO })
    expect(equalPay(q(null, 7035))).toEqual({ kind: 'problem', problem: SHARE_ZERO })
    expect(SHARE_ZERO).toBe('The share came back as RM 0.00 — check the bill')
  })
})

describe('payLabelFor: the order screen\'s Payment button', () => {
  it('shows the balance: the total less what the parts paid, never below 0', () => {
    expect(payLabelFor(7035, 0)).toBe('Payment RM 70.35')
    expect(payLabelFor(7035, 2345)).toBe('Payment RM 46.90')
    expect(payLabelFor(7035, 7035)).toBe('Payment RM 0.00')
    expect(payLabelFor(5000, 7035)).toBe('Payment RM 0.00')   // the bill shrank below its parts
  })
})

describe('parsers', () => {
  it('pos_part_quote', () => {
    const q = { totalSen: 7035, paidSen: 0, balanceSen: 7035, partsPaid: 0, sharesPaid: 0, ways: 3, shareSen: 2345 }
    expect(parsePartQuote(q)).toEqual(q)
    expect(parsePartQuote({ ...q, ways: null, shareSen: null })).toEqual({ ...q, ways: null, shareSen: null })
    expect(() => parsePartQuote({ totalSen: 1 })).toThrow('Unexpected reply from the server')
  })
  it('pay_bill_part', () => {
    const r = { partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, payments: [], changeSen: 2655, receiptQueued: true }
    expect(parsePartResult(r)).toEqual({ partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, changeSen: 2655, receiptQueued: true })
    expect(() => parsePartResult({ partId: 'x1' })).toThrow('Unexpected reply from the server')
  })
  it('pos_checkout_state parts', () => {
    expect(parseBillParts([{ id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }])).toEqual([parts[0]])
    expect(() => parseBillParts([{ id: 'x1' }])).toThrow('Unexpected reply from the server')
  })
})
