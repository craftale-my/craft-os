import { describe, expect, it } from 'vitest'
import { groupByFee, groupByRoute, parseNewFee, parseNewRoute } from './productGroups'
import { menuRow as row } from './testing/menuRow'

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
    expect(parseNewFee('RM 2')).toEqual({ value: 200 })
    expect(parseNewFee('abc')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('0')).toEqual({ problem: 'A fee must be more than RM 0.00 — Remove takes a product off its fee' })
  })

  it('a new route is a name; one already in use keeps its spelling', () => {
    expect(parseNewRoute('  Pastry   bar ', ['Bar', 'Kitchen'])).toEqual({ value: 'Pastry bar' })
    expect(parseNewRoute('bar', ['Bar', 'Kitchen'])).toEqual({ value: 'Bar' })
    expect(parseNewRoute('   ', ['Bar'])).toEqual({ problem: 'Route name is required' })
    expect(parseNewRoute('x'.repeat(41), ['Bar'])).toEqual({ problem: 'Route name is too long (at most 40 characters)' })
  })
})
