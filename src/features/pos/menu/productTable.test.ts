import { describe, expect, it } from 'vitest'
import {
  NO_FILTER, defaultPrice, feeText, headerState, routeChoices, routeText, soldInText, sstText, tableReducer, tableRows,
  variantCountText, type TableState,
} from './productTable'
import { menuRow as row } from './testing/menuRow'

const v = (name: string, price_sen: number, sort_order: number, is_active = true) => ({ id: name, name, price_sen, is_active, sort_order })

describe('tableRows', () => {
  const rows = [
    row({ name: 'Smoked Duck DON', sort_order: 1, category_id: 'don', category: { name: 'DONBURI', sort_order: 1 } }),
    row({ name: 'Lychee Rose', sort_order: 2 }),
    row({ name: 'Apple Tea', sort_order: 1 }),
    row({ name: 'Oat milk', is_addon: true, category_id: 'addon', category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Old Tea', sort_order: 3, is_active: false }),
    row({ name: 'Mystery', category_id: null, category: null }),
  ]

  it('is one flat list: category order, then product order, uncategorised last', () => {
    expect(tableRows(rows, NO_FILTER).map((r) => r.name)).toEqual(['Apple Tea', 'Lychee Rose', 'Smoked Duck DON', 'Mystery'])
  })

  it('applies the filters and the search', () => {
    expect(tableRows(rows, { ...NO_FILTER, showAddons: true, showInactive: true }).map((r) => r.name))
      .toEqual(['Apple Tea', 'Lychee Rose', 'Old Tea', 'Smoked Duck DON', 'Oat milk', 'Mystery'])
    expect(tableRows(rows, { ...NO_FILTER, search: 'TEA' }).map((r) => r.name)).toEqual(['Apple Tea'])
    expect(tableRows(rows, { ...NO_FILTER, categoryId: 'don' }).map((r) => r.name)).toEqual(['Smoked Duck DON'])
  })
})

describe('cells', () => {
  it('prices the default variant: the first switched-on one in variant order', () => {
    expect(defaultPrice([v('Large', 1450, 1), v('Regular', 1250, 0)])).toBe('RM 12.50')
    expect(defaultPrice([v('Regular', 1250, 0, false), v('Large', 1450, 1)])).toBe('RM 14.50')
    expect(defaultPrice([v('Regular', 1250, 0, false)])).toBe('—')
    expect(defaultPrice([])).toBe('—')
  })

  it('counts the switched-on variants when there is more than one', () => {
    expect(variantCountText([v('a', 1, 0), v('b', 1, 1), v('c', 1, 2, false)])).toBe('2 variants')
    expect(variantCountText([v('a', 1, 0), v('b', 1, 1, false)])).toBe('')
    expect(variantCountText([])).toBe('')
  })

  it('names two catalogs, then +N', () => {
    expect(soldInText([])).toBe('No catalog')
    expect(soldInText(['Craft Cafe'])).toBe('Craft Cafe')
    expect(soldInText(['Craft Cafe', 'Grab Food'])).toBe('Craft Cafe, Grab Food')
    expect(soldInText(['Craft Cafe', 'Grab Food', 'QR', 'Staff Meal'])).toBe('Craft Cafe, Grab Food +2')
  })

  it('writes SST, takeaway fee and print route the way the table shows them', () => {
    expect(sstText(600)).toBe('6%')
    expect(sstText(0)).toBe('0%')
    expect(feeText(100)).toBe('RM 1.00')
    expect(feeText(0)).toBe('—')
    expect(routeText('Bar')).toBe('Bar')
    expect(routeText(null)).toBe('No ticket')
  })

  it("offers Feedme's print routes, then the other names products use, A–Z", () => {
    expect(routeChoices([{ print_route: 'Kitchen' }, { print_route: 'Pastry' }, { print_route: null }, { print_route: 'Dessert' }]))
      .toEqual(['Bar', 'Kitchen', 'Bakery', 'Front House', 'Dessert', 'Pastry'])
    expect(routeChoices([])).toEqual(['Bar', 'Kitchen', 'Bakery', 'Front House'])
  })
})

describe('tableReducer', () => {
  const start: TableState = { filter: NO_FILTER, selected: new Set() }

  it('ticks and unticks one row', () => {
    const s = tableReducer(start, { type: 'toggle', id: 'a' })
    expect([...s.selected]).toEqual(['a'])
    expect([...tableReducer(s, { type: 'toggle', id: 'a' }).selected]).toEqual([])
  })

  it('select all ticks every visible row; a second time unticks them', () => {
    const some = tableReducer(start, { type: 'toggle', id: 'a' })
    const all = tableReducer(some, { type: 'toggleAll', visibleIds: ['a', 'b', 'c'] })
    expect([...all.selected].sort()).toEqual(['a', 'b', 'c'])
    expect(tableReducer(all, { type: 'toggleAll', visibleIds: ['a', 'b', 'c'] }).selected.size).toBe(0)
    expect(tableReducer(start, { type: 'toggleAll', visibleIds: [] }).selected.size).toBe(0)
  })

  it('a filter or search change clears the ticks and keeps the other filters', () => {
    const ticked = tableReducer({ ...start, filter: { ...NO_FILTER, showAddons: true } }, { type: 'toggle', id: 'a' })
    const s = tableReducer(ticked, { type: 'filter', patch: { search: 'latte' } })
    expect(s.selected.size).toBe(0)
    expect(s.filter).toEqual({ ...NO_FILTER, showAddons: true, search: 'latte' })
  })

  it('Clear unticks everything', () => {
    const s = tableReducer(tableReducer(start, { type: 'toggle', id: 'a' }), { type: 'toggle', id: 'b' })
    expect(tableReducer(s, { type: 'clear' }).selected.size).toBe(0)
  })

  it('prune drops ticks on rows no longer visible and keeps the rest', () => {
    const s = ['a', 'b', 'c'].reduce((acc, id) => tableReducer(acc, { type: 'toggle', id }), start)
    const pruned = tableReducer(s, { type: 'prune', visible: ['b', 'c', 'z'] })
    expect([...pruned.selected].sort()).toEqual(['b', 'c'])
    expect(pruned.filter).toBe(s.filter)
    expect(tableReducer(s, { type: 'prune', visible: [] }).selected.size).toBe(0)
  })

  it('prune returns the same state when nothing is dropped (no re-render loop)', () => {
    const s = tableReducer(start, { type: 'toggle', id: 'a' })
    expect(tableReducer(s, { type: 'prune', visible: ['a', 'b'] })).toBe(s)
    expect(tableReducer(start, { type: 'prune', visible: [] })).toBe(start)
  })
})

describe('headerState', () => {
  it('says whether all, some or none of the visible rows are ticked', () => {
    expect(headerState(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
    expect(headerState(new Set(['a']), ['a', 'b'])).toBe('some')
    expect(headerState(new Set(), ['a', 'b'])).toBe('none')
    expect(headerState(new Set(), [])).toBe('none')
  })
})
