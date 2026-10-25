import { describe, expect, it } from 'vitest'
import { groupByFee, groupByRoute, parseFeeSen, parseNewFee, parseNewRoute } from './productGroups'
import { menuRow as row } from './testing/menuRow'

const CAP = 'A packaging fee can be at most RM 10.00'
const RESERVED = 'That name is reserved — choose another'
const BAD = 'Enter the fee in RM, e.g. 1.50'
const ZERO = 'A fee must be more than RM 0.00 — Remove takes a product off its fee'

const rows = [
  row({ name: 'Latte', takeaway_fee_sen: 100, print_route: 'Bar', sort_order: 1 }),
  row({ name: 'Mocha', takeaway_fee_sen: 100, print_route: 'Bar', sort_order: 2, is_active: false }),
  row({ name: 'Grab Latte', takeaway_fee_sen: 106, print_route: 'Bar', sort_order: 3 }),
  row({ name: 'Duck DON', takeaway_fee_sen: 100, print_route: 'Kitchen', category_id: 'don', category: { name: 'DONBURI', sort_order: 1 } }),
  row({ name: 'Croissant', category_id: 'bakery', category: { name: 'BAKERY', sort_order: 2 } }),
  row({ name: 'Oat milk', is_addon: true, takeaway_fee_sen: 100, print_route: 'Bar' }),
]

describe('groupByFee', () => {
  it('one group per amount, lowest first, No fee last; add-on items left out, switched-off products counted', () => {
    const g = groupByFee(rows)
    expect(g.map((x) => [x.label, x.products.length])).toEqual([['RM 1.00', 3], ['RM 1.06', 1], ['No fee', 1]])
    expect(g.map((x) => x.value)).toEqual([100, 106, 0])
    expect(g[0].products.map((p) => p.name)).toEqual(['Latte', 'Mocha', 'Duck DON'])
  })
})

describe('groupByRoute', () => {
  it('one group per route name, A–Z, No ticket last', () => {
    const g = groupByRoute(rows)
    expect(g.map((x) => [x.label, x.products.length])).toEqual([['Bar', 3], ['Kitchen', 1], ['No ticket', 1]])
    expect(g[g.length - 1].value).toBeNull()
  })

  it('has no group for an empty menu', () => {
    expect(groupByRoute([])).toEqual([])
    expect(groupByFee([row({ name: 'Oat milk', is_addon: true })])).toEqual([])
  })
})

describe('+ New', () => {
  it('a new fee is an amount in RM above zero', () => {
    expect(parseNewFee('1.50')).toEqual({ value: 150 })
    expect(parseNewFee('2')).toEqual({ value: 200 })
    expect(parseNewFee('15')).toEqual({ problem: CAP })
    expect(parseNewFee('abc')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('0')).toEqual({ problem: 'A fee must be more than RM 0.00 — Remove takes a product off its fee' })
  })

  it('a new route is a name; one already in use keeps its spelling', () => {
    expect(parseNewRoute('  Pastry   bar ', ['Bar', 'Kitchen'])).toEqual({ value: 'Pastry bar' })
    expect(parseNewRoute('bar', ['Bar', 'Kitchen'])).toEqual({ value: 'Bar' })
    expect(parseNewRoute('   ', ['Bar'])).toEqual({ problem: 'Route name is required' })
    expect(parseNewRoute('No ticket', ['Bar'])).toEqual({ problem: RESERVED })
    expect(parseNewRoute('  NO   Ticket ', ['Bar'])).toEqual({ problem: RESERVED })
    expect(parseNewRoute('null', ['Bar'])).toEqual({ problem: RESERVED })
    expect(parseNewRoute('NULL', ['Bar'])).toEqual({ problem: RESERVED })
    expect(parseNewRoute('Nullable', ['Bar'])).toEqual({ value: 'Nullable' })
    expect(parseNewRoute('x'.repeat(41), ['Bar'])).toEqual({ problem: 'Route name is too long (at most 40 characters)' })
  })
})

describe('parseFeeSen', () => {
  const bulk = { allowZero: true }
  const one = { allowZero: false }

  it('reads digits with at most 2 decimals, in whole sen', () => {
    for (const mode of [bulk, one]) {
      expect(parseFeeSen('1', mode)).toEqual({ value: 100 })
      expect(parseFeeSen('1.5', mode)).toEqual({ value: 150 })
      expect(parseFeeSen('1.50', mode)).toEqual({ value: 150 })
      expect(parseFeeSen('.5', mode)).toEqual({ value: 50 })
      expect(parseFeeSen(' 1.50 ', mode)).toEqual({ value: 150 })
      expect(parseFeeSen('1.15', mode)).toEqual({ value: 115 })
      expect(parseFeeSen('10', mode)).toEqual({ value: 1000 })
    }
  })

  it('refuses commas, a third decimal, signs and anything else', () => {
    for (const mode of [bulk, one]) {
      for (const t of ['1,5', '1,50', '1.005', '-1', 'abc', '', '   ', 'RM 2', '1.', '.', '1e2', '+1']) {
        expect(parseFeeSen(t, mode)).toEqual({ problem: BAD })
      }
    }
  })

  it('refuses 0 unless the bulk bar asks for it', () => {
    expect(parseFeeSen('0', bulk)).toEqual({ value: 0 })
    expect(parseFeeSen('0.00', bulk)).toEqual({ value: 0 })
    expect(parseFeeSen('0', one)).toEqual({ problem: ZERO })
    expect(parseFeeSen('0.00', one)).toEqual({ problem: ZERO })
  })

  it('caps a fee at RM 10.00', () => {
    for (const mode of [bulk, one]) {
      expect(parseFeeSen('10.00', mode)).toEqual({ value: 1000 })
      expect(parseFeeSen('10.01', mode)).toEqual({ problem: CAP })
      expect(parseFeeSen('15', mode)).toEqual({ problem: CAP })
      expect(parseFeeSen('99999999999999999999', mode)).toEqual({ problem: CAP })
    }
  })
})
