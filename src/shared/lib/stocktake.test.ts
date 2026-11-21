import { describe, it, expect } from 'vitest'
import {
  packsLooseToBase, baseToPacksLoose, itemsForCount, groupForCounting, groupProgress,
  uncountedItems, uncountedSpots, countSpotTotal, sortResultLines, entryKey, strayEntries, UNASSIGNED,
} from './stocktake'
import type { Item, StorageLocation, ItemLocation, StockCountEntry } from '../types'

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id, name: id, name_zh: null, category: 'raw', departments: [], department: null,
    supplier_id: null, purchase_unit: 'pack', base_unit: 'g', conversion_rate: 1000,
    latest_price: null, min_stock_alert: 0, status: 'active', created_at: '', count_weekly: false,
    ...over,
  }
}
const loc = (id: string, sort: number, active = true): StorageLocation =>
  ({ id, branch_id: 'b1', name: id.toUpperCase(), sort_order: sort, is_active: active, created_at: '' })

describe('packsLooseToBase', () => {
  it('adds packs times the rate to the loose amount', () => {
    expect(packsLooseToBase(3, 250, 1000)).toBe(3250)
  })
  it('treats a blank half as zero', () => {
    expect(packsLooseToBase(2, null, 1000)).toBe(2000)
    expect(packsLooseToBase(null, 40, 1000)).toBe(40)
  })
  it('returns null when both halves are blank', () => {
    expect(packsLooseToBase(null, null, 1000)).toBeNull()
  })
  it('rounds away floating-point noise to 3 dp', () => {
    expect(packsLooseToBase(3, null, 1.1)).toBe(3.3)
    expect(packsLooseToBase(0.1, 0.2, 1)).toBe(0.3)
    expect(packsLooseToBase(null, 1.23456, 1000)).toBe(1.235)
  })
})

describe('baseToPacksLoose', () => {
  it('splits base units into whole packs and the rest', () => {
    expect(baseToPacksLoose(3250, 1000)).toEqual({ packs: 3, loose: 250 })
  })
  it('keeps everything in packs when the rate is 1', () => {
    expect(baseToPacksLoose(7, 1)).toEqual({ packs: 7, loose: 0 })
  })
  it('does not lose a pack to floating point', () => {
    expect(baseToPacksLoose(0.3 * 10, 0.1 * 10)).toEqual({ packs: 3, loose: 0 })
  })
})

describe('itemsForCount', () => {
  const items = [item('a', { count_weekly: true }), item('b'), item('c', { count_weekly: true, status: 'inactive' })]
  it('weekly = active key items', () => {
    expect(itemsForCount(items, 'weekly').map(i => i.id)).toEqual(['a'])
  })
  it('full = every active item', () => {
    expect(itemsForCount(items, 'full').map(i => i.id)).toEqual(['a', 'b'])
  })
})

describe('groupForCounting', () => {
  const items = [item('milk'), item('beans'), item('cups')]
  const locations = [loc('back', 2), loc('bar', 1), loc('old', 0, false)]
  const links: ItemLocation[] = [
    { item_id: 'milk', location_id: 'bar', sort_order: 2 },
    { item_id: 'beans', location_id: 'bar', sort_order: 1 },
    { item_id: 'milk', location_id: 'back', sort_order: 1 },
    { item_id: 'cups', location_id: 'old', sort_order: 1 },
  ]
  const groups = groupForCounting(items, locations, links)
  it('orders active locations by sort_order and puts Unassigned last', () => {
    expect(groups.map(g => g.key)).toEqual(['bar', 'back', UNASSIGNED])
  })
  it('orders items inside a location by their sort_order', () => {
    expect(groups[0].items.map(i => i.id)).toEqual(['beans', 'milk'])
  })
  it('lists an item in every location it sits in', () => {
    expect(groups[1].items.map(i => i.id)).toEqual(['milk'])
  })
  it('sends items only in inactive locations to Unassigned', () => {
    expect(groups[2]).toMatchObject({ label: 'Unassigned', locationId: null })
    expect(groups[2].items.map(i => i.id)).toEqual(['cups'])
  })
  it('drops Unassigned when it is empty', () => {
    expect(groupForCounting([item('milk')], locations, links).map(g => g.key)).toEqual(['bar', 'back'])
  })
})

describe('groupProgress', () => {
  it('counts items with an entry at that location', () => {
    const g = { key: 'bar', label: 'BAR', locationId: 'bar', items: [item('a'), item('b')] }
    const entries = new Map([[entryKey('a', 'bar'), 5], [entryKey('b', null), 2]])
    expect(groupProgress(g, entries)).toEqual({ done: 1, total: 2 })
  })
})

describe('uncountedItems', () => {
  it('returns items with no entry anywhere', () => {
    const entries = [{ item_id: 'a', location_id: 'bar', counted_base: 0 }] as StockCountEntry[]
    expect(uncountedItems([item('a'), item('b')], entries).map(i => i.id)).toEqual(['b'])
  })
})

describe('uncountedSpots', () => {
  const e = (item_id: string, location_id: string | null, counted_base = 1) =>
    ({ item_id, location_id, counted_base }) as StockCountEntry
  const milk = item('milk'), tea = item('tea')
  const groups = groupForCounting(
    [milk, tea], [loc('bar', 0), loc('back', 1)],
    [{ item_id: 'milk', location_id: 'bar', sort_order: 0 }, { item_id: 'milk', location_id: 'back', sort_order: 0 },
     { item_id: 'tea', location_id: 'bar', sort_order: 1 }] as ItemLocation[],
  )
  it('counts one spot per linked location', () => {
    expect(countSpotTotal(groups)).toBe(3)
  })
  it('lists every linked location with no entry', () => {
    const r = uncountedSpots(groups, [e('milk', 'bar', 4)])
    expect(r.map(s => `${s.item.id}@${s.locationId}`)).toEqual(['tea@bar', 'milk@back'])
  })
  it('accepts 0 as counted', () => {
    expect(uncountedSpots(groups, [e('milk', 'bar', 4), e('milk', 'back', 0), e('tea', 'bar', 0)])).toEqual([])
  })
  it('an entry at an unlinked location does not cover a linked spot', () => {
    const r = uncountedSpots(groups, [e('milk', 'bar'), e('milk', null), e('tea', 'bar')])
    expect(r.map(s => `${s.item.id}@${s.locationId}`)).toEqual(['milk@back'])
  })
  it('an item linked to no active location needs an entry anywhere', () => {
    const g = groupForCounting([item('x')], [loc('bar', 0)], [])
    expect(uncountedSpots(g, [])).toHaveLength(1)
    expect(uncountedSpots(g, [e('x', null, 0)])).toEqual([])
    expect(uncountedSpots(g, [e('x', 'bar')])).toEqual([])
  })
})

describe('sortResultLines', () => {
  it('puts the biggest RM difference first, either sign, then by name', () => {
    const lines = [
      { name: 'b', variance_value: -2 }, { name: 'a', variance_value: 5 },
      { name: 'c', variance_value: -9 }, { name: 'd', variance_value: 2 },
    ]
    expect(sortResultLines(lines).map(l => l.name)).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('strayEntries', () => {
  const items = [item('milk'), item('beans'), item('cups')]
  const locations = [loc('bar', 1), loc('old', 2, false)]
  const links: ItemLocation[] = [
    { item_id: 'milk', location_id: 'bar', sort_order: 1 },
    { item_id: 'beans', location_id: 'bar', sort_order: 2 },
  ]
  const groups = groupForCounting(items, locations, links)
  const e = (item_id: string, location_id: string | null) =>
    ({ item_id, location_id, counted_base: 1 }) as StockCountEntry

  it('keeps nothing when every entry is on a shown row', () => {
    expect(strayEntries(items, groups, [e('milk', 'bar'), e('cups', null)])).toEqual([])
  })
  it('finds an entry at a removed location', () => {
    expect(strayEntries(items, groups, [e('milk', 'old')])).toEqual([e('milk', 'old')])
  })
  it('finds an Unassigned entry for an item that now has a location', () => {
    expect(strayEntries(items, groups, [e('beans', null)])).toEqual([e('beans', null)])
  })
  it('finds an entry at a location the item was unlinked from', () => {
    expect(strayEntries(items, groups, [e('cups', 'bar')])).toEqual([e('cups', 'bar')])
  })
  it('ignores entries for items outside the count', () => {
    expect(strayEntries(items, groups, [e('gone', 'old')])).toEqual([])
  })
})
