import { describe, expect, it } from 'vitest'
import { liveChangeSen, numpadPress, payTabs, singleLines } from './payTabs'
import type { TenderMethod } from './tender'

const m = (id: string, kind: TenderMethod['kind'], needsReference = false): TenderMethod => ({ id, name: id, kind, needsReference })
const cash = m('Cash', 'cash')
const card = m('Visa', 'card', true)

describe('payTabs', () => {
  it('groups methods into Cash, Card, E-payment and Other, in that order, keeping each tab\'s order', () => {
    const tabs = payTabs([m('TNG', 'ewallet'), card, m('Voucher', 'other'), cash, m('DuitNow QR', 'duitnow')])
    expect(tabs.map((t) => [t.label, t.methods.map((x) => x.id)])).toEqual([
      ['Cash', ['Cash']], ['Card', ['Visa']], ['E-payment', ['TNG', 'DuitNow QR']], ['Other', ['Voucher']],
    ])
  })
  it('leaves out a tab with no active method', () => {
    expect(payTabs([cash, m('TNG', 'ewallet')]).map((t) => t.tab)).toEqual(['cash', 'epay'])
    expect(payTabs([])).toEqual([])
  })
})

describe('numpadPress', () => {
  const type = (keys: string[]) => keys.reduce(numpadPress, '')
  it('types ringgit and sen', () => {
    expect(type(['5', '0'])).toBe('50')
    expect(type(['1', '2', '.', '5'])).toBe('12.5')
    expect(type(['.', '5'])).toBe('0.5')
    expect(type(['0', '7'])).toBe('7')
  })
  it('ignores a second point, a third decimal and a seventh whole digit', () => {
    expect(type(['1', '.', '.', '2'])).toBe('1.2')
    expect(type(['1', '.', '2', '5', '9'])).toBe('1.25')
    expect(type(['1', '2', '3', '4', '5', '6', '7'])).toBe('123456')
  })
  it('backspace and clear', () => {
    expect(numpadPress('12.5', '⌫')).toBe('12.')
    expect(numpadPress('', '⌫')).toBe('')
    expect(numpadPress('12.5', 'C')).toBe('')
  })
})

describe('singleLines', () => {
  it('cash exact, cash with change, a card with its reference', () => {
    expect(singleLines(cash, 10670, '', '')).toEqual({ lines: [{ method: cash, amountSen: 10670, tenderedSen: null, reference: null }] })
    expect(singleLines(cash, 10670, '150', '')).toEqual({ lines: [{ method: cash, amountSen: 10670, tenderedSen: 15000, reference: null }] })
    expect(singleLines(card, 10670, '', ' 123456 ')).toEqual({ lines: [{ method: card, amountSen: 10670, tenderedSen: null, reference: '123456' }] })
  })
  it('the same words as tender.ts when something is missing', () => {
    expect(singleLines(cash, 10670, '100', '')).toEqual({ problem: 'Cash received is less than the amount' })
    expect(singleLines(cash, 10670, 'abc', '')).toEqual({ problem: 'Enter the cash received' })
    expect(singleLines(card, 10670, '', '')).toEqual({ problem: 'Enter the reference for Visa' })
  })
  it('a bill of RM 0.00 takes no payment', () => {
    expect(singleLines(cash, 0, '', '')).toEqual({ lines: [] })
  })
})

describe('liveChangeSen', () => {
  it('exact is no change; short or unreadable is null', () => {
    expect(liveChangeSen(10670, '')).toBe(0)
    expect(liveChangeSen(10670, '150')).toBe(4330)
    expect(liveChangeSen(10670, '100')).toBeNull()
    expect(liveChangeSen(10670, '1.2.3')).toBeNull()
  })
})
