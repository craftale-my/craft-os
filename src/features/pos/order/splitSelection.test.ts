import { describe, expect, it } from 'vitest'
import type { BillItemRow } from './posApi'
import {
  guestLabels, guestPicked, toggleGuest,
  canSplit, everythingSelected, liveUnits, movedNotice, ofLabel, parseMoveItemsResult, pickedUnits, prune, selectAll, setQty,
  splitLines, splitTitle, toSplitItems, SPLIT_ACTION_LABEL, SPLIT_OFFLINE, MOVE_NEEDS_NO_DISCOUNT, BILL_CHANGED_ITEMS,
} from './splitSelection'

const row = (id: string, name: string, qty: number, unit: number, voided = false): BillItemRow => ({
  id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty, note: id === 'i2' ? 'no sugar' : null, modifiers_snapshot: id === 'i1' ? [{ name: 'Oat milk' }] : [],
  voided_at: voided ? '2026-11-16T04:10:00Z' : null, catalog_discount_bp: 0, catalog_discount_name: null,
  discount_kind: null, discount_value: null, discount_reason: null,
  orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
})
const lines = splitLines([row('i1', 'Latte', 3, 1300), row('i2', 'Cake', 1, 1500), row('i3', 'Soup', 1, 900, true)])

describe('splitLines', () => {
  it('lists the live lines in bill order with name, modifiers, note and line price', () => {
    expect(lines).toEqual([
      { id: 'i1', name: 'Latte', mods: ['Oat milk'], note: null, qty: 3, amountSen: 3900, guest: null },
      { id: 'i2', name: 'Cake', mods: [], note: 'no sugar', qty: 1, amountSen: 1500, guest: null },
    ])
    expect(liveUnits(lines)).toBe(4)
  })
})

describe('the stepper and the tick box', () => {
  it('a stepper goes 0…qty and never past either end', () => {
    let p = setQty({}, lines, 'i1', 2)
    expect(p).toEqual({ i1: 2 })
    p = setQty(p, lines, 'i1', 5)
    expect(p).toEqual({ i1: 3 })
    p = setQty(p, lines, 'i1', -1)
    expect(p).toEqual({})
  })
  it('an unknown line changes nothing', () => {
    const p = { i1: 1 }
    expect(setQty(p, lines, 'nope', 1)).toBe(p)
  })
  it('select all picks every unit; clear is the empty pick', () => {
    expect(selectAll(lines)).toEqual({ i1: 3, i2: 1 })
    expect(pickedUnits(selectAll(lines))).toBe(4)
    expect(pickedUnits({})).toBe(0)
  })
})

describe('everything selected', () => {
  it('only when every unit of every live line is picked', () => {
    expect(everythingSelected(selectAll(lines), lines)).toBe(true)
    expect(everythingSelected({ i1: 2, i2: 1 }, lines)).toBe(false)
    expect(everythingSelected({}, [])).toBe(false)
  })
})

describe('toSplitItems and prune', () => {
  it('p_items in bill order, picked lines only, each with the line\'s qty the picker shows (lineQty)', () => {
    expect(toSplitItems({ i2: 1, i1: 1 }, lines)).toEqual([{ itemId: 'i1', qty: 1, lineQty: 3 }, { itemId: 'i2', qty: 1, lineQty: 1 }])
    expect(toSplitItems({}, lines)).toEqual([])
  })
  it('lineQty is the line as read now: a Pay selected that landed late (3 → 2) makes the old view refused by the server', () => {
    const after = splitLines([row('i1', 'Latte', 2, 1300), row('i2', 'Cake', 1, 1500)])
    expect(toSplitItems({ i1: 1 }, lines)).toEqual([{ itemId: 'i1', qty: 1, lineQty: 3 }])
    expect(toSplitItems({ i1: 1 }, after)).toEqual([{ itemId: 'i1', qty: 1, lineQty: 2 }])
  })
  it('after the bill changed: a gone line is dropped, a smaller line caps its pick', () => {
    const after = splitLines([row('i1', 'Latte', 2, 1300)])
    expect(prune({ i1: 3, i2: 1 }, after)).toEqual({ i1: 2 })
  })
})

describe('copy', () => {
  it('is the spec words', () => {
    expect(ofLabel(2, 3)).toBe('2 of 3')
    expect(movedNotice(2, 'T7')).toBe('Moved 2 items to T7')
    expect(movedNotice(1, 'T7')).toBe('Moved 1 item to T7')
    expect(splitTitle('Table T5')).toBe('Table T5 · Split')
    expect(SPLIT_ACTION_LABEL).toBe('Split / Move items')
    expect(SPLIT_OFFLINE).toBe('Split needs a connection')
    expect(MOVE_NEEDS_NO_DISCOUNT).toBe('Remove the bill discount before moving items')
    expect(BILL_CHANGED_ITEMS).toBe('The bill changed. Check the items again.')
  })
  it('a bill splits with at least two units', () => {
    expect(canSplit(1)).toBe(false)
    expect(canSplit(2)).toBe(true)
  })
})

describe('parseMoveItemsResult', () => {
  it('reads move_items\' answer', () => {
    expect(parseMoveItemsResult({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 }))
      .toEqual({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 })
  })
  it('refuses anything else', () => {
    expect(() => parseMoveItemsResult(null)).toThrow('Unexpected reply from the server')
    expect(() => parseMoveItemsResult({ targetBillId: 'b7', movedUnits: 2 })).toThrow('Unexpected reply from the server')
  })
})

describe('pick by guest', () => {
  const g = splitLines([
    { ...row('a', 'Latte', 2, 1300), guest_label: 'Eric' },
    { ...row('b', 'Cake', 1, 1500), guest_label: 'Mei' },
    { ...row('c', 'Mocha', 1, 1400), guest_label: 'Eric' },
    row('d', 'Tea', 1, 800),                                   // ordered at the counter
  ])
  it('lists the guests on the bill once each, in bill order, without the counter', () => {
    expect(guestLabels(g)).toEqual(['Eric', 'Mei'])
    expect(g.map((l) => l.guest)).toEqual(['Eric', 'Mei', 'Eric', null])
  })
  it('a tap picks every unit of that guest and keeps what was picked', () => {
    const p = toggleGuest({ b: 1 }, g, 'Eric')
    expect(p).toEqual({ a: 2, b: 1, c: 1 })
    expect(guestPicked(p, g, 'Eric')).toBe(true)
    expect(guestPicked(p, g, 'Mei')).toBe(true)
  })
  it('a guest is picked only when every unit of theirs is', () => {
    expect(guestPicked({ a: 1, c: 1 }, g, 'Eric')).toBe(false)
    expect(guestPicked({}, g, 'Nobody')).toBe(false)
  })
  it('a second tap takes that guest\'s lines out and leaves the rest', () => {
    expect(toggleGuest({ a: 2, b: 1, c: 1 }, g, 'Eric')).toEqual({ b: 1 })
  })
  it('a tap on a partly picked guest completes the pick', () => {
    expect(toggleGuest({ a: 1 }, g, 'Eric')).toEqual({ a: 2, c: 1 })
  })
})
