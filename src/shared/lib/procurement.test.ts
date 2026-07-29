import { describe, it, expect } from 'vitest'
import {
  toBaseUnits, toPurchaseUnits, calcShortage, derivePoStatus,
  priceDelta, isBelowAlert, poTotal, formatPoText, qty,
} from './procurement'

describe('unit conversion', () => {
  it('converts purchase units to base units', () => {
    // 1 包 = 2000 g
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
    { item: { name: 'Coffee Beans', name_zh: '咖啡豆', purchase_unit: '包' }, quantity_ordered: 12, unit_price: 45 },
    { item: { name: 'Oat Milk', name_zh: null, purchase_unit: '箱' }, quantity_ordered: 2, unit_price: 10.5 },
  ]

  it('includes the header, every line and the total', () => {
    const text = formatPoText(po, { name: 'ABC Trading' }, 'Cheras', 'Craft Cafe', lines)
    expect(text).toContain('PO-20260729-001')
    expect(text).toContain('Craft Cafe · Cheras')
    expect(text).toContain('Supplier: ABC Trading')
    expect(text).toContain('1. Coffee Beans (咖啡豆)')
    expect(text).toContain('12 包 × RM 45.00 = RM 540.00')
    expect(text).toContain('2. Oat Milk')
    expect(text).toContain('*TOTAL: RM 561.00*')
  })

  it('omits the Chinese name when the item has none', () => {
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
