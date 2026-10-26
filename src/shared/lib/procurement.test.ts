import { describe, it, expect } from 'vitest'
import {
  toBaseUnits, toPurchaseUnits, calcShortage, derivePoStatus,
  priceDelta, isBelowAlert, poTotal, formatPoText, qty,
  stockValue, buildStockRows,
  outstandingQty, deriveCumulativePoStatus, applyDelivery, isReceivable,
  unitCostPerBase, ledgerValue, movingAverageCost, formatUnitCost,
  overQty, lineOverReceived, deliveryNeedsNote, canCloseShort, shortfallLines,
  weekStartMYT, validateWastage, sumWastage,
} from './procurement'
import type { InventoryBalance, InventoryValuation, Item, PoStatus } from '../types'

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

  it('accepts more than is outstanding — received can exceed ordered and the PO is received', () => {
    const partly = [{ id: 'a', quantity_ordered: 10, received_quantity: 7 }]
    const next = applyDelivery(partly, [{ po_item_id: 'a', actual_quantity: 4 }])
    expect(next[0].received_quantity).toBe(11)
    expect(outstandingQty(next[0])).toBe(0)
    expect(lineOverReceived(next[0])).toBe(1)
    expect(deriveCumulativePoStatus(next)).toBe('received')
  })

  it('handles a mixed delivery — one line short, one over', () => {
    const next = applyDelivery(lines, [
      { po_item_id: 'a', actual_quantity: 8 },
      { po_item_id: 'b', actual_quantity: 6 },
    ])
    expect(next.map(l => l.received_quantity)).toEqual([8, 6])
    expect(next.map(outstandingQty)).toEqual([2, 0])
    expect(next.map(lineOverReceived)).toEqual([0, 2])
    expect(deriveCumulativePoStatus(next)).toBe('partially_received')
    expect(shortfallLines(next).map(l => l.id)).toEqual(['a'])
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

  it('rejects a closed-short PO', () => {
    expect(isReceivable('closed_short')).toBe(false)
  })
})

describe('overQty', () => {
  it('is the extra beyond what was outstanding', () => {
    expect(overQty(3, 5)).toBe(2)
  })

  it('is 0 on an exact or short delivery', () => {
    expect(overQty(3, 3)).toBe(0)
    expect(overQty(3, 1)).toBe(0)
  })

  it('counts everything as extra when nothing was outstanding', () => {
    expect(overQty(0, 2)).toBe(2)
  })
})

describe('lineOverReceived', () => {
  it('is received beyond ordered', () => {
    expect(lineOverReceived({ quantity_ordered: 10, received_quantity: 12 })).toBe(2)
  })

  it('is 0 when not over-received', () => {
    expect(lineOverReceived({ quantity_ordered: 10, received_quantity: 10 })).toBe(0)
    expect(lineOverReceived({ quantity_ordered: 10, received_quantity: 4 })).toBe(0)
  })
})

describe('deliveryNeedsNote', () => {
  it('is true when any line exceeds what is outstanding', () => {
    expect(deliveryNeedsNote([
      { outstanding: 5, actual: 5 },
      { outstanding: 3, actual: 4 },
    ])).toBe(true)
  })

  it('is false for exact and short deliveries', () => {
    expect(deliveryNeedsNote([
      { outstanding: 5, actual: 5 },
      { outstanding: 3, actual: 1 },
    ])).toBe(false)
  })

  it('is false for an empty delivery', () => {
    expect(deliveryNeedsNote([])).toBe(false)
  })
})

describe('canCloseShort', () => {
  const statuses: PoStatus[] = ['draft', 'sent', 'partially_received', 'received', 'cancelled', 'closed_short']

  it('allows only a partially received PO, and only for managers', () => {
    for (const s of statuses) {
      expect(canCloseShort(s, true)).toBe(s === 'partially_received')
    }
  })

  it('never allows users without manage_procurement (e.g. supervisors)', () => {
    for (const s of statuses) {
      expect(canCloseShort(s, false)).toBe(false)
    }
  })
})

describe('shortfallLines', () => {
  it('keeps only lines with something still outstanding', () => {
    const lines = [
      { id: 'a', quantity_ordered: 10, received_quantity: 6 },
      { id: 'b', quantity_ordered: 4, received_quantity: 4 },
      { id: 'c', quantity_ordered: 2, received_quantity: 3 },
      { id: 'd', quantity_ordered: 5, received_quantity: 0 },
    ]
    expect(shortfallLines(lines).map(l => l.id)).toEqual(['a', 'd'])
  })

  it('is empty when everything arrived', () => {
    expect(shortfallLines([{ quantity_ordered: 1, received_quantity: 1 }])).toEqual([])
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

  it('does not match the legacy name_zh column', () => {
    const blend = makeItem({ id: 'blend', name: 'House Blend', name_zh: 'Kopi' })
    expect(buildStockRows({ ...base, items: [blend], search: 'kopi' })).toEqual([])
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

  it('falls back to the latest price with plain balances, with an average cost', () => {
    const rows = buildStockRows(base)
    // 85 per 1000 g bag ⇒ 0.085 / g
    expect(rows.find(r => r.item.id === 'beans')?.avgCost).toBeCloseTo(0.085)
    expect(rows.find(r => r.item.id === 'flour')?.avgCost).toBeNull()
    expect(rows.find(r => r.item.id === 'cups')?.avgCost).toBeNull()
  })
})

describe('unitCostPerBase', () => {
  it('scales the purchase-unit price down to one base unit', () => {
    expect(unitCostPerBase(42, 250)).toBeCloseTo(0.168)
  })

  it('is null without a price or a positive rate', () => {
    expect(unitCostPerBase(null, 250)).toBeNull()
    expect(unitCostPerBase(42, null)).toBeNull()
    expect(unitCostPerBase(42, 0)).toBeNull()
    expect(unitCostPerBase(42, -5)).toBeNull()
  })

  it('treats a zero price as a zero cost', () => {
    expect(unitCostPerBase(0, 250)).toBe(0)
  })
})

describe('ledgerValue', () => {
  it('keeps the receipt cost when the item conversion rate is edited later', () => {
    // 4 bags of 250 g at RM 42 ⇒ 1000 g at 0.168 / g = RM 168
    const ledger = [{ quantity: 1000, unit_cost: unitCostPerBase(42, 250) }]
    expect(ledgerValue(ledger)).toBeCloseTo(168)

    // Supplier moves the bag to 200 g; the item's rate is edited to 200.
    const editedRate = 200
    expect(ledgerValue(ledger)).toBeCloseTo(168)
    // The deprecated live-rate valuation re-prices the same stock.
    expect(stockValue(1000, 42, editedRate)).toBeCloseTo(210)
  })

  it('sums receipts at different prices', () => {
    expect(ledgerValue([
      { quantity: 24000, unit_cost: 0.012 },
      { quantity: 6000, unit_cost: 0.0125 },
    ])).toBeCloseTo(363)
  })

  it('subtracts negative adjustments at their stamped cost', () => {
    expect(ledgerValue([
      { quantity: 1000, unit_cost: 0.1 },
      { quantity: -200, unit_cost: 0.1 },
    ])).toBeCloseTo(80)
  })

  it('counts rows without a cost as zero', () => {
    expect(ledgerValue([
      { quantity: 1000, unit_cost: 0.1 },
      { quantity: 500, unit_cost: null },
    ])).toBeCloseTo(100)
  })

  it('accepts numeric strings from PostgREST', () => {
    const rows = [{ quantity: '1000', unit_cost: '0.168' }] as unknown as { quantity: number; unit_cost: number }[]
    expect(ledgerValue(rows)).toBeCloseTo(168)
  })

  it('is zero for no rows', () => {
    expect(ledgerValue([])).toBe(0)
  })
})

describe('movingAverageCost', () => {
  it('weights each receipt by quantity', () => {
    expect(movingAverageCost([
      { quantity: 24000, unit_cost: 0.012 },
      { quantity: 6000, unit_cost: 0.0125 },
    ])).toBeCloseTo(0.0121, 6)
  })

  it('is unchanged by an adjustment at the average cost', () => {
    expect(movingAverageCost([
      { quantity: 24000, unit_cost: 0.012 },
      { quantity: 6000, unit_cost: 0.0125 },
      { quantity: -10000, unit_cost: 0.0121 },
    ])).toBeCloseTo(0.0121, 6)
  })

  it('is null when nothing is held', () => {
    expect(movingAverageCost([])).toBeNull()
    expect(movingAverageCost([
      { quantity: 500, unit_cost: 0.1 },
      { quantity: -500, unit_cost: 0.1 },
    ])).toBeNull()
    expect(movingAverageCost([
      { quantity: 500, unit_cost: 0.1 },
      { quantity: -800, unit_cost: 0.1 },
    ])).toBeNull()
  })

  it('dilutes the average with uncosted rows', () => {
    expect(movingAverageCost([
      { quantity: 1000, unit_cost: 0.1 },
      { quantity: 1000, unit_cost: null },
    ])).toBeCloseTo(0.05)
  })
})

describe('formatUnitCost', () => {
  it('shows four decimals per base unit', () => {
    expect(formatUnitCost(0.085, 'g')).toBe('RM 0.0850 / g')
    expect(formatUnitCost(0.0121, 'ml')).toBe('RM 0.0121 / ml')
  })

  it('shows a dash when unknown', () => {
    expect(formatUnitCost(null, 'g')).toBe('—')
  })
})

describe('buildStockRows with valuation rows', () => {
  const beans = makeItem({ id: 'beans', name: 'Coffee Beans', conversion_rate: 200, latest_price: 42 })
  const milk = makeItem({ id: 'milk', name: 'Milk', base_unit: 'ml', latest_price: 12 })
  const cups = makeItem({ id: 'cups', name: 'Paper Cups', base_unit: 'pcs', latest_price: 30 })
  const items = [beans, milk, cups]
  const valuation: InventoryValuation[] = [
    // b1: 1000 g received at 0.168 / g (250 g bags) — the item is now 200 g bags.
    { item_id: 'beans', branch_id: 'b1', balance: 1000, stock_value: 168, avg_unit_cost: 0.168, uncosted_rows: 0 },
    { item_id: 'beans', branch_id: 'b2', balance: 500, stock_value: 100, avg_unit_cost: 0.2, uncosted_rows: 0 },
    { item_id: 'milk', branch_id: 'b1', balance: 30000, stock_value: 363, avg_unit_cost: 0.0121, uncosted_rows: 0 },
    { item_id: 'milk', branch_id: 'b2', balance: 0, stock_value: 0, avg_unit_cost: null, uncosted_rows: 0 },
    { item_id: 'cups', branch_id: 'b1', balance: -5, stock_value: -1, avg_unit_cost: null, uncosted_rows: 0 },
  ]
  const base = { items, balances: valuation, branchId: 'all', department: 'all' as const, search: '' }

  it('uses the ledger value for one branch, not the live rate', () => {
    const rows = buildStockRows({ ...base, branchId: 'b1' })
    const beansRow = rows.find(r => r.item.id === 'beans')
    expect(beansRow?.value).toBeCloseTo(168)
    expect(beansRow?.avgCost).toBeCloseTo(0.168)
    // The deprecated valuation would say 210.
    expect(stockValue(1000, 42, 200)).toBeCloseTo(210)
    const milkRow = rows.find(r => r.item.id === 'milk')
    expect(milkRow?.value).toBeCloseTo(363)
    expect(milkRow?.avgCost).toBeCloseTo(0.0121, 6)
  })

  it("sums ledger values across branches for 'all'", () => {
    const beansRow = buildStockRows(base).find(r => r.item.id === 'beans')
    expect(beansRow?.balance).toBe(1500)
    expect(beansRow?.value).toBeCloseTo(268)
    expect(beansRow?.avgCost).toBeCloseTo(268 / 1500)
  })

  it('has no average cost at zero or negative balance', () => {
    const rows = buildStockRows({ ...base, branchId: 'b2' })
    expect(rows.find(r => r.item.id === 'milk')?.avgCost).toBeNull()
    expect(rows.find(r => r.item.id === 'milk')?.value).toBe(0)
    const cupsRow = buildStockRows({ ...base, branchId: 'b1' }).find(r => r.item.id === 'cups')
    expect(cupsRow?.balance).toBe(-5)
    expect(cupsRow?.avgCost).toBeNull()
  })

  it('values items without a counted valuation row at zero, not the latest price', () => {
    // b2 has no cups row; latest price would give a non-null value.
    const cupsRow = buildStockRows({ ...base, branchId: 'b2' }).find(r => r.item.id === 'cups')
    expect(cupsRow?.value).toBe(0)
    expect(cupsRow?.avgCost).toBeNull()
  })

  it('accepts numeric strings from PostgREST', () => {
    const asStrings = [
      { item_id: 'beans', branch_id: 'b1', balance: '1000', stock_value: '168', avg_unit_cost: '0.168', uncosted_rows: '0' },
    ] as unknown as InventoryValuation[]
    const beansRow = buildStockRows({ ...base, balances: asStrings }).find(r => r.item.id === 'beans')
    expect(beansRow?.value).toBeCloseTo(168)
    expect(beansRow?.avgCost).toBeCloseTo(0.168)
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
    { item: { name: 'Coffee Beans', purchase_unit: 'bag' }, quantity_ordered: 12, unit_price: 45 },
    { item: { name: 'Oat Milk', purchase_unit: 'carton' }, quantity_ordered: 2, unit_price: 10.5 },
  ]

  it('includes the header, every line and the total', () => {
    const text = formatPoText(po, { name: 'ABC Trading' }, 'Cheras', 'Craft Cafe', lines)
    expect(text).toContain('PO-20260729-001')
    expect(text).toContain('Craft Cafe · Cheras')
    expect(text).toContain('Supplier: ABC Trading')
    expect(text).toContain('1. Coffee Beans')
    expect(text).toContain('12 bag × RM 45.00 = RM 540.00')
    expect(text).toContain('2. Oat Milk')
    expect(text).toContain('*TOTAL: RM 561.00*')
  })

  it('lists each item by its name only', () => {
    const text = formatPoText(po, { name: 'ABC Trading' }, 'Cheras', 'Craft Cafe', lines)
    expect(text).toContain('1. Coffee Beans\n')
    expect(text).toContain('2. Oat Milk\n')
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

describe('weekStartMYT', () => {
  it('puts Sunday 23:30 MYT in the week that started the previous Monday', () => {
    // Sun 1 Nov 2026 23:30 MYT = 15:30 UTC
    expect(weekStartMYT(new Date('2026-11-01T15:30:00Z')).toISOString()).toBe('2026-10-25T16:00:00.000Z')
  })

  it('starts a new week at Monday 00:00 MYT exactly', () => {
    // Mon 2 Nov 2026 00:00 MYT = Sun 1 Nov 16:00 UTC
    const monday = new Date('2026-11-01T16:00:00Z')
    expect(weekStartMYT(monday).toISOString()).toBe('2026-11-01T16:00:00.000Z')
    expect(weekStartMYT(new Date(monday.getTime() - 1)).toISOString()).toBe('2026-10-25T16:00:00.000Z')
  })

  it('treats Sunday 16:30 UTC as Monday 00:30 MYT', () => {
    expect(weekStartMYT(new Date('2026-11-01T16:30:00Z')).toISOString()).toBe('2026-11-01T16:00:00.000Z')
  })

  it('handles mid-week times', () => {
    // Wed 28 Oct 2026 10:00 MYT
    expect(weekStartMYT(new Date('2026-10-28T02:00:00Z')).toISOString()).toBe('2026-10-25T16:00:00.000Z')
  })
})

describe('validateWastage', () => {
  const ok = { quantity: 200, reason: 'expired', note: null, onHand: 500, baseUnit: 'g' }

  it('accepts a valid entry', () => {
    expect(validateWastage(ok)).toBeNull()
  })

  it('requires a quantity greater than zero', () => {
    expect(validateWastage({ ...ok, quantity: 0 })).toBe('Quantity must be greater than zero')
    expect(validateWastage({ ...ok, quantity: -1 })).toBe('Quantity must be greater than zero')
    expect(validateWastage({ ...ok, quantity: NaN })).toBe('Quantity must be greater than zero')
  })

  it('rejects more than is on hand, allows exactly what is on hand', () => {
    expect(validateWastage({ ...ok, quantity: 600 }))
      .toBe('Cannot log 600 g of wastage: only 500 g on hand at this branch')
    expect(validateWastage({ ...ok, quantity: 500 })).toBeNull()
    expect(validateWastage({ ...ok, onHand: 0, quantity: 1 }))
      .toBe('Cannot log 1 g of wastage: only 0 g on hand at this branch')
  })

  it('leaves the stock check to the RPC when on-hand is unknown', () => {
    expect(validateWastage({ ...ok, onHand: null, quantity: 1e6 })).toBeNull()
  })

  it('requires a note for Other only', () => {
    expect(validateWastage({ ...ok, reason: 'other', note: '  ' })).toBe('A note is required when the reason is Other')
    expect(validateWastage({ ...ok, reason: 'other', note: 'Dropped tray' })).toBeNull()
    expect(validateWastage({ ...ok, reason: 'damaged', note: null })).toBeNull()
  })

  it('requires one of the four reasons', () => {
    expect(validateWastage({ ...ok, reason: null })).toBe('Pick a reason')
    expect(validateWastage({ ...ok, reason: 'stolen' })).toBe('Unknown wastage reason: stolen')
    for (const r of ['expired', 'damaged', 'production_error']) {
      expect(validateWastage({ ...ok, reason: r })).toBeNull()
    }
  })
})

describe('sumWastage', () => {
  const items = [
    makeItem({ id: 'beans', name: 'Beans', department: 'cafe_bar' }),
    makeItem({ id: 'flour', name: 'Flour', department: 'bakery' }),
    makeItem({ id: 'misc', name: 'Misc', department: null }),
  ]
  const logs = [
    { item_id: 'beans', branch_id: 'b1', value: 10 },
    { item_id: 'beans', branch_id: 'b2', value: 5 },
    { item_id: 'flour', branch_id: 'b1', value: 2.5 },
    { item_id: 'misc', branch_id: 'b1', value: 1 },
    { item_id: 'flour', branch_id: 'b1', value: null },
    // Item no longer active — not in `items`.
    { item_id: 'gone', branch_id: 'b1', value: 4 },
  ]

  it('sums every row for all branches and departments', () => {
    const { total, byItem } = sumWastage(logs, { branchId: 'all', department: 'all', items })
    expect(total).toBe(22.5)
    expect(byItem.get('beans')).toBe(15)
    expect(byItem.get('flour')).toBe(2.5)
    expect(byItem.get('gone')).toBe(4)
  })

  it('filters by branch', () => {
    const { total, byItem } = sumWastage(logs, { branchId: 'b2', department: 'all', items })
    expect(total).toBe(5)
    expect(byItem.get('beans')).toBe(5)
    expect(byItem.has('flour')).toBe(false)
  })

  it('filters by department', () => {
    expect(sumWastage(logs, { branchId: 'all', department: 'cafe_bar', items }).total).toBe(15)
    expect(sumWastage(logs, { branchId: 'b1', department: 'bakery', items }).total).toBe(2.5)
    expect(sumWastage(logs, { branchId: 'all', department: 'kitchen', items }).total).toBe(0)
  })

  it("'unassigned' matches items without a department, not unknown items", () => {
    const { total, byItem } = sumWastage(logs, { branchId: 'all', department: 'unassigned', items })
    expect(total).toBe(1)
    expect(byItem.has('gone')).toBe(false)
  })

  it('treats numeric strings from PostgREST as numbers', () => {
    const rows = [{ item_id: 'beans', branch_id: 'b1', value: '1.25' as unknown as number }]
    expect(sumWastage(rows, { branchId: 'all', department: 'all', items }).total).toBe(1.25)
  })
})
