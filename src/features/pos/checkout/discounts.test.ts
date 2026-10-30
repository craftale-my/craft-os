import { describe, expect, it } from 'vitest'
import { catalogTag, discountLabel, discountProblem, lineDiscountRows, linesById, parseDiscount, storedDiscount } from './discounts'

const item = { catalog_discount_bp: 5000, catalog_discount_name: 'Staff Meal', discount_kind: 'percent' as const, discount_value: 1000, discount_reason: 'Regular' }

describe('discountProblem / parseDiscount (the server\'s words)', () => {
  it('a whole percent from 1 to 100', () => {
    expect(discountProblem('percent', '')).toBe('Enter a discount')
    expect(discountProblem('percent', '0')).toBe('Enter a whole percent from 1 to 100')
    expect(discountProblem('percent', '12.5')).toBe('Enter a whole percent from 1 to 100')
    expect(discountProblem('percent', '101')).toBe('Enter a whole percent from 1 to 100')
    expect(parseDiscount('percent', '10')).toEqual({ kind: 'percent', value: 1000 })
    expect(parseDiscount('percent', '100')).toEqual({ kind: 'percent', value: 10000 })
  })
  it('an amount in ringgit above 0.00, at most two decimals', () => {
    expect(discountProblem('amount', '0.00')).toBe('Enter an amount above RM 0.00')
    expect(discountProblem('amount', '1.234')).toBe('Enter an amount above RM 0.00')
    expect(parseDiscount('amount', '4.30')).toEqual({ kind: 'amount', value: 430 })
    expect(parseDiscount('amount', '5')).toEqual({ kind: 'amount', value: 500 })
    expect(parseDiscount('amount', 'abc')).toBeNull()
  })
})

describe('labels and rows', () => {
  it('"Discount 10%" or "Discount", with the reason on screens', () => {
    expect(discountLabel({ kind: 'percent', value: 1000, reason: 'Regular' }, true)).toBe('Discount 10% (Regular)')
    expect(discountLabel({ kind: 'amount', value: 500, reason: 'Regular' }, false)).toBe('Discount')
    expect(discountLabel({ kind: 'amount', value: 500, reason: null }, true)).toBe('Discount')
  })
  it('storedDiscount reads the discount_* columns', () => {
    expect(storedDiscount(item)).toEqual({ kind: 'percent', value: 1000, reason: 'Regular' })
    expect(storedDiscount({ discount_kind: null, discount_value: null, discount_reason: null })).toBeNull()
  })
  it('a line shows what actually came off: catalog first, then its own discount', () => {
    expect(lineDiscountRows(item, { catalogDiscountSen: 1250, itemDiscountSen: 125 })).toEqual([
      { label: 'Staff Meal 50%', amountSen: 1250 },
      { label: 'Discount 10% (Regular)', amountSen: 125 },
    ])
    expect(lineDiscountRows(item, { catalogDiscountSen: 0, itemDiscountSen: 0 })).toEqual([])
    expect(lineDiscountRows(item, undefined)).toEqual([])
  })
  it('linesById skips drafts and old totals without lines', () => {
    const t = { lines: [{ id: 'a', catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: 1 }, { id: null, catalogDiscountSen: 0, itemDiscountSen: 0, billShareSen: 0, netSen: 2 }] }
    expect([...linesById(t as never).keys()]).toEqual(['a'])
    expect(linesById({} as never).size).toBe(0)
    expect(linesById(null).size).toBe(0)
  })
  it('the bill tag comes from the first live item with a catalog discount', () => {
    expect(catalogTag([{ ...item, voided_at: '2026-10-30T01:00:00Z' }, { ...item, voided_at: null }])).toBe('Staff Meal 50%')
    expect(catalogTag([{ ...item, catalog_discount_bp: 0, voided_at: null }])).toBeNull()
  })
})
