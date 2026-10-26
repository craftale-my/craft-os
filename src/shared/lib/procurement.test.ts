import { describe, it, expect } from 'vitest'
import {
  toBaseUnits, toPurchaseUnits, calcShortage, derivePoStatus,
  priceDelta, isBelowAlert, poTotal, formatPoText, qty,
  stockValue, buildStockRows,
  outstandingQty, deriveCumulativePoStatus, applyDelivery, isReceivable,
} from './procurement'
import type { InventoryBalance, Item } from '../types'

function makeItem(overrides: Partial<Item> & Pick<Item, 'id' | 'name'>): Item {
  return {
    name_zh: null,
    category: 'raw',
    department: null,
    supplier_id: null,
    purchase_unit: 'bag',
    base_unit: 'g',
    conversion_rate: 1000,
    latest_price: null,
    min_stock_alert: 0,
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

describe('unit conversion', () => {
  it('converts purchase units to base units', () => {
    // 1 bag = 2000 g
    expect(toBaseUnits(3, 2000)).toBe(6000)
  })

  it('round-trips through base units', () => {
    expect(toPurchaseUnits(toBaseUnits(2.5, 2000), 2000)).toBe(2.5)
  })

  it('returns 0 rather than Infinity when the rate is missing', () => {
    expect(toPurchaseUnits(500, 0)).toBe(0)
  })
})

describe('calcShortage', () => {
  it('reports the shortfall', () => {
    expect(calcShortage(12, 10)).toBe(2)
  })

  it('is zero on an exact delivery', () => {
    expect(calcShortage(12, 12)).toBe(0)
  })

  it('does not go negative when more arrives than ordered', () => {
    expect(calcShortage(12, 15)).toBe(0)
  })
})

describe('derivePoStatus', () => {
  it('is received when every line arrived in full', () => {
    expect(derivePoStatus([
      { quantity_ordered: 12, actual_quantity: 12 },
      { quantity_ordered: 5, actual_quantity: 5 },
    ])).toBe('received')
  })

  it('is partially_received when any line is short', () => {
    expect(derivePoStatus([
      { quantity_ordered: 12, actual_quantity: 12 },
      { quantity_ordered: 5, actual_quantity: 3 },
    ])).toBe('partially_received')
  })

  it('treats over-delivery as fully received', () => {
    expect(derivePoStatus([{ quantity_ordered: 5, actual_quantity: 6 }])).toBe('received')
  })
})

describe('outstandingQty', () => {
  it('is ordered minus received so far', () => {
    expect(outstandingQty({ quantity_ordered: 12, received_quantity: 5 })).toBe(7)
  })

  it('is 0 when fully received', () => {
    expect(outstandingQty({ quantity_ordered: 12, received_quantity: 12 })).toBe(0)
  })

  it('never goes negative when over-received', () => {
    expect(outstandingQty({ quantity_ordered: 12, received_quantity: 15 })).toBe(0)
  })
})

describe('deriveCumulativePoStatus', () => {
  it('is received when every line is fully in', () => {
    expect(deriveCumulativePoStatus([
      { quantity_ordered: 12, received_quantity: 12 },
      { quantity_ordered: 5, received_quantity: 5 },
    ])).toBe('received')
  })

  it('is partially_received when any line is still short', () => {
    expect(deriveCumulativePoStatus([
      { quantity_ordered: 12, received_quantity: 12 },
      { quantity_ordered: 5, received_quantity: 3 },
    ])).toBe('partially_received')
  })

  it('counts an over-received line as full', () => {
    expect(deriveCumulativePoStatus([{ quantity_ordered: 5, received_quantity: 6 }])).toBe('received')
  })

  it('treats an empty PO as partially_received', () => {
    expect(deriveCumulativePoStatus([])).toBe('partially_received')
  })
})

describe('applyDelivery', () => {
  const lines = [
    { id: 'a', quantity_ordered: 10, received_quantity: 0 },
    { id: 'b', quantity_ordered: 4, received_quantity: 0 },
  ]

  it('accumulates across two deliveries until the PO is received', () => {
    const first = applyDelivery(lines, [
      { po_item_id: 'a', actual_quantity: 6 },
      { po_item_id: 'b', actual_quantity: 0 },
    ])
    expect(first.map(l => l.received_quantity)).toEqual([6, 0])
    expect(deriveCumulativePoStatus(first)).toBe('partially_received')

    const second = applyDelivery(first, [
      { po_item_id: 'a', actual_quantity: 4 },
      { po_item_id: 'b', actual_quantity: 4 },
    ])
    expect(second.map(l => l.received_quantity)).toEqual([10, 4])
    expect(deriveCumulativePoStatus(second)).toBe('received')
  })

  it('leaves lines missing from the delivery unchanged and does not mutate input', () => {
    const next = applyDelivery(lines, [{ po_item_id: 'a', actual_quantity: 3 }])
    expect(next[1]).toBe(lines[1])
    expect(lines[0].received_quantity).toBe(0)
  })

  it('throws when receiving more than is outstanding', () => {
    const partly = [{ id: 'a', quantity_ordered: 10, received_quantity: 7 }]
    expect(() => applyDelivery(partly, [{ po_item_id: 'a', actual_quantity: 4 }])).toThrow(/only 3 outstanding/)
  })

  it('throws on a negative quantity', () => {
    expect(() => applyDelivery(lines, [{ po_item_id: 'a', actual_quantity: -1 }])).toThrow(/zero or more/)
  })

  it('throws on an unknown po_item_id', () => {
    expect(() => applyDelivery(lines, [{ po_item_id: 'zzz', actual_quantity: 1 }])).toThrow(/does not belong/)
  })

  it('throws when a line appears twice', () => {
    expect(() => applyDelivery(lines, [
      { po_item_id: 'a', actual_quantity: 1 },
      { po_item_id: 'a', actual_quantity: 1 },
    ])).toThrow(/more than once/)
  })
})

describe('isReceivable', () => {
  it('accepts sent and partially_received', () => {
    expect(isReceivable('sent')).toBe(true)
    expect(isReceivable('partially_received')).toBe(true)
  })

  it('rejects every other status', () => {
    expect(isReceivable('draft')).toBe(false)
    expect(isReceivable('received')).toBe(false)
    expect(isReceivable('cancelled')).toBe(false)
  })
})

describe('priceDelta', () => {
  it('detects a price rise', () => {
    const d = priceDelta(42, 45)
    expect(d.direction).toBe('up')
    expect(d.amount).toBe(3)
    expect(d.percent).toBeCloseTo(7.14, 2)
  })

  it('detects a price drop with a negative percentage', () => {
    const d = priceDelta(45, 42)
    expect(d.direction).toBe('down')
    expect(d.amount).toBe(3)
    expect(d.percent).toBeCloseTo(-6.67, 2)
  })

  it('reports no change', () => {
    expect(priceDelta(45, 45)).toEqual({ direction: 'same', amount: 0, percent: 0 })
  })

  it('does not divide by zero when there is no reference price', () => {
    const d = priceDelta(0, 45)
    expect(d.direction).toBe('up')
    expect(d.percent).toBe(0)
  })
})

describe('isBelowAlert', () => {
  it('alerts at or below the threshold', () => {
    expect(isBelowAlert(500, 1000)).toBe(true)
    expect(isBelowAlert(1000, 1000)).toBe(true)
  })

  it('stays quiet above the threshold', () => {
    expect(isBelowAlert(1500, 1000)).toBe(false)
  })

  it('never alerts when no threshold is set', () => {
    expect(isBelowAlert(0, 0)).toBe(false)
  })
})

describe('stockValue', () => {
  it('prices base units off the per-purchase-unit price', () => {
    // RM 85 per 1000 g bag, 2500 g on hand
    expect(stockValue(2500, 85, 1000)).toBeCloseTo(212.5)
  })

  it('is null without a price', () => {
    expect(stockValue(2500, null, 1000)).toBeNull()
  })

  it('is null when the conversion rate is zero or negative', () => {
    expect(stockValue(2500, 85, 0)).toBeNull()
    expect(stockValue(2500, 85, -1)).toBeNull()
  })

  it('is zero for an empty shelf with a price', () => {
    expect(stockValue(0, 85, 1000)).toBe(0)
  })
})

describe('buildStockRows', () => {
  const beans = makeItem({ id: 'beans', name: 'Coffee Beans', department: 'cafe_bar', latest_price: 85, min_stock_alert: 1000 })
  const flour = makeItem({ id: 'flour', name: 'Flour', department: 'bakery', min_stock_alert: 500 })
  const cups = makeItem({ id: 'cups', name: 'Paper Cups', department: null, base_unit: 'pcs' })
  const items = [cups, flour, beans]
  const balances: InventoryBalance[] = [
    { item_id: 'beans', branch_id: 'b1', balance: 800 },
    { item_id: 'beans', branch_id: 'b2', balance: 700 },
    { item_id: 'flour', branch_id: 'b1', balance: 500 },
    { item_id: 'flour', branch_id: 'b2', balance: 2000 },
    { item_id: 'cups', branch_id: 'b1', balance: 0 },
  ]
  const base = { items, balances, branchId: 'all', department: 'all' as const, search: '' }

  it('sums every branch when branchId is all', () => {
    const rows = buildStockRows(base)
    expect(rows.find(r => r.item.id === 'beans')?.balance).toBe(1500)
    expect(rows.find(r => r.item.id === 'flour')?.balance).toBe(2500)
  })

  it('counts only the chosen branch otherwise', () => {
    const rows = buildStockRows({ ...base, branchId: 'b2' })
    expect(rows.find(r => r.item.id === 'beans')?.balance).toBe(700)
    expect(rows.find(r => r.item.id === 'cups')?.balance).toBe(0)
  })

  it('treats items without a balance row as zero', () => {
    const rows = buildStockRows({ ...base, balances: [] })
    expect(rows.every(r => r.balance === 0)).toBe(true)
  })

  it('filters by department', () => {
    expect(buildStockRows({ ...base, department: 'bakery' }).map(r => r.item.id)).toEqual(['flour'])
    expect(buildStockRows({ ...base, department: 'kitchen' })).toEqual([])
  })

  it("filters items without a department under 'unassigned'", () => {
    expect(buildStockRows({ ...base, department: 'unassigned' }).map(r => r.item.id)).toEqual(['cups'])
  })

  it('searches by name, case-insensitively', () => {
    expect(buildStockRows({ ...base, search: '  cOfFeE ' }).map(r => r.item.id)).toEqual(['beans'])
  })

  it('counts stock exactly at the threshold as low', () => {
    const rows = buildStockRows({ ...base, branchId: 'b1' })
    expect(rows.find(r => r.item.id === 'flour')?.low).toBe(true)
  })

  it('never flags an item with a zero threshold', () => {
    const rows = buildStockRows(base)
    const cupsRow = rows.find(r => r.item.id === 'cups')
    expect(cupsRow?.balance).toBe(0)
    expect(cupsRow?.low).toBe(false)
  })

  it('sorts low stock first, then by name', () => {
    const zest = makeItem({ id: 'zest', name: 'Zest', min_stock_alert: 100 })
    const rows = buildStockRows({ ...base, items: [...items, zest], branchId: 'b2' })
    // b2: beans 700 and zest 0 are low; flour and cups are not
    expect(rows.map(r => r.item.id)).toEqual(['beans', 'zest', 'flour', 'cups'])
  })

  it('is alphabetical when nothing is low', () => {
    expect(buildStockRows(base).map(r => r.item.id)).toEqual(['beans', 'flour', 'cups'])
  })

  it('attaches the stock value, or null without a price', () => {
    const rows = buildStockRows(base)
    expect(rows.find(r => r.item.id === 'beans')?.value).toBeCloseTo(127.5)
    expect(rows.find(r => r.item.id === 'flour')?.value).toBeNull()
  })
})

describe('poTotal', () => {
  it('sums line totals', () => {
    expect(poTotal([
      { quantity_ordered: 12, unit_price: 45 },
      { quantity_ordered: 2, unit_price: 10.5 },
    ])).toBe(561)
  })

  it('is zero for an empty order', () => {
    expect(poTotal([])).toBe(0)
  })
})

describe('qty', () => {
  it('drops trailing zeros on whole numbers', () => {
    expect(qty(2000)).toBe('2000')
  })

  it('keeps meaningful decimals', () => {
    expect(qty(1.5)).toBe('1.5')
  })
})

describe('formatPoText', () => {
  const po = { po_number: 'PO-20260729-001', created_at: '2026-07-29T02:00:00Z', notes: null }
  const lines = [
    { item: { name: 'Coffee Beans', name_zh: 'Kopi', purchase_unit: 'bag' }, quantity_ordered: 12, unit_price: 45 },
    { item: { name: 'Oat Milk', name_zh: null, purchase_unit: 'carton' }, quantity_ordered: 2, unit_price: 10.5 },
  ]

  it('includes the header, every line and the total', () => {
    const text = formatPoText(po, { name: 'ABC Trading' }, 'Cheras', 'Craft Cafe', lines)
    expect(text).toContain('PO-20260729-001')
    expect(text).toContain('Craft Cafe · Cheras')
    expect(text).toContain('Supplier: ABC Trading')
    expect(text).toContain('1. Coffee Beans (Kopi)')
    expect(text).toContain('12 bag × RM 45.00 = RM 540.00')
    expect(text).toContain('2. Oat Milk')
    expect(text).toContain('*TOTAL: RM 561.00*')
  })

  it('omits the secondary name when the item has none', () => {
    const text = formatPoText(po, { name: 'ABC Trading' }, 'Cheras', 'Craft Cafe', lines)
    expect(text).toContain('2. Oat Milk\n')
    expect(text).not.toContain('Oat Milk (')
  })

  it('appends notes only when present', () => {
    const withNotes = formatPoText({ ...po, notes: 'Deliver before 10am' }, { name: 'ABC' }, 'Cheras', 'Craft Cafe', lines)
    expect(withNotes).toContain('Notes: Deliver before 10am')
    expect(formatPoText(po, { name: 'ABC' }, 'Cheras', 'Craft Cafe', lines)).not.toContain('Notes:')
  })

  it('handles a missing supplier without crashing', () => {
    expect(formatPoText(po, null, 'Cheras', 'Craft Cafe', lines)).toContain('Supplier: —')
  })
})
