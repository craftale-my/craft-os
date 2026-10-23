import { describe, it, expect } from 'vitest'
import { changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments, type TenderLine, type TenderMethod } from './tender'

const cash: TenderMethod = { id: 'm-cash', name: 'Cash', kind: 'cash', needsReference: false }
const card: TenderMethod = { id: 'm-card', name: 'Maybank Terminal', kind: 'card', needsReference: true }
const tng: TenderMethod = { id: 'm-tng', name: "Touch 'n Go", kind: 'ewallet', needsReference: false }

describe('parseRinggit', () => {
  it('reads ringgit amounts as sen', () => {
    expect(parseRinggit('12.5')).toBe(1250)
    expect(parseRinggit('RM 92.80')).toBe(9280)
    expect(parseRinggit('100')).toBe(10000)
    expect(parseRinggit('1,000.00')).toBe(100000)
  })
  it('refuses junk', () => {
    expect(parseRinggit('')).toBeNull()
    expect(parseRinggit('12.345')).toBeNull()
    expect(parseRinggit('-5')).toBeNull()
    expect(parseRinggit('abc')).toBeNull()
  })
})

describe('split tender', () => {
  const lines: TenderLine[] = [
    { key: '1', method: tng, amountSen: 5000, tenderedSen: null, reference: null },
    { key: '2', method: cash, amountSen: 4280, tenderedSen: 5000, reference: null },
  ]
  it('tracks what is left and the change (cash only)', () => {
    expect(remainingSen(9280, lines)).toBe(0)
    expect(remainingSen(9280, lines.slice(0, 1))).toBe(4280)
    expect(changeSen(lines)).toBe(720)
  })
  it('offers the notes that cover what is due', () => {
    expect(quickTenders(4280)).toEqual([5000, 10000])
    expect(quickTenders(10000)).toEqual([])
  })
  it('says why a line or Pay is not possible', () => {
    expect(lineProblem({ method: cash, amountSen: 1000, tenderedSen: 500, reference: null }, 4280)).toBe('Cash received is less than the amount')
    expect(lineProblem({ method: tng, amountSen: 1000, tenderedSen: 2000, reference: null }, 4280)).toBe('Only cash can be tendered above the amount')
    expect(lineProblem({ method: card, amountSen: 1000, tenderedSen: null, reference: ' ' }, 4280)).toBe('Enter the reference for Maybank Terminal')
    expect(lineProblem({ method: card, amountSen: 5000, tenderedSen: null, reference: '1' }, 4280)).toBe('That is more than what is left to pay')
    expect(lineProblem({ method: card, amountSen: 0, tenderedSen: null, reference: '1' }, 4280)).toBe('Invalid payment amount')
    expect(lineProblem({ method: card, amountSen: 4280, tenderedSen: null, reference: '004512' }, 4280)).toBeNull()
    expect(payProblem(9280, lines.slice(0, 1))).toBe('RM 42.80 left to pay')
    expect(payProblem(9280, lines)).toBeNull()
  })
  it('builds the checkout_bill payments', () => {
    expect(toPayments([...lines, { key: '3', method: card, amountSen: 1, tenderedSen: 99, reference: ' 77 ' }])).toEqual([
      { methodId: 'm-tng', amountSen: 5000, tenderedSen: null, reference: null },
      { methodId: 'm-cash', amountSen: 4280, tenderedSen: 5000, reference: null },
      { methodId: 'm-card', amountSen: 1, tenderedSen: null, reference: '77' },
    ])
  })
})
