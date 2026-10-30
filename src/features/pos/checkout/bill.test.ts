import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeBill, discountOffSen, formatRate, lineDiscounts, roundingDeltaSen, shareBillDiscount, type BillInput, type BillOrderType, type BillTotals } from './bill'
import vectors from './billVectors.json'

interface Vector { name: string; input: BillInput; expected: BillTotals }
const all = vectors as Vector[]

describe('computeBill — shared vectors (same numbers as the SQL verify script)', () => {
  it('has the vectors the design asks for', () => {
    expect(all).toHaveLength(32)
    expect(all[0].expected.totalSen).toBe(9280) // receipt #87846
  })
  for (const v of all) {
    it(v.name, () => {
      expect(computeBill(v.input)).toEqual(v.expected)
    })
  }
})

describe('the SQL verify script carries the very same vectors', () => {
  it('matches billVectors.json exactly', () => {
    const sql = readFileSync(new URL('../../../../supabase/migration-2026-10-30-pos-discounts-verify.sql', import.meta.url), 'utf8')
    const m = sql.match(/\$vectors\$([\s\S]*?)\$vectors\$/)
    expect(m).not.toBeNull()
    expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual(vectors)
  })
})

// Apart and merged agree up to 1 sen per service-charge or SST rate both parts share (each rate is
// rounded on the whole bill); the merge vector's bases round without a remainder, so here they are equal.
describe('a merged bill totals what its bills would have totalled apart (owner, 2026-10-25)', () => {
  it('the merge vector equals its dine-in and its takeaway part, before the whole-bill rounding', () => {
    const merged = all.find((v) => v.name.startsWith('merge:'))!.input
    const part = (orderType: BillOrderType): BillInput => ({
      ...merged,
      orderType,
      tableId: orderType === 'dine_in' ? merged.tableId : null,
      lines: merged.lines.filter((l) => (l.orderType ?? merged.orderType) === orderType),
    })
    const a = computeBill(part('dine_in'))
    const b = computeBill(part('takeaway'))
    const m = computeBill(merged)
    expect(b.takeawayFeeSen).toBe(250)
    expect([m.subtotalSen, m.serviceChargeSen, m.sstSen, m.takeawayFeeSen, m.beforeRoundingSen]).toEqual([
      a.subtotalSen + b.subtotalSen, a.serviceChargeSen + b.serviceChargeSen, a.sstSen + b.sstSen,
      a.takeawayFeeSen + b.takeawayFeeSen, a.beforeRoundingSen + b.beforeRoundingSen,
    ])
  })
})

describe('roundingDeltaSen', () => {
  it('rounds to the nearest 5 sen', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(roundingDeltaSen)).toEqual([0, -1, -2, 2, 1, 0, -1, -2, 2, 1])
  })
})

describe('formatRate', () => {
  it('prints basis points as a percentage', () => {
    expect(formatRate(600)).toBe('6%')
    expect(formatRate(650)).toBe('6.5%')
    expect(formatRate(1000)).toBe('10%')
    expect(formatRate(0)).toBe('0%')
  })
})

describe('discountOffSen', () => {
  it('a percent rounds half up; an amount stops at the base; nothing off a zero base', () => {
    expect(discountOffSen({ kind: 'percent', value: 1000 }, 1125)).toBe(113) // 112.5 → 113
    expect(discountOffSen({ kind: 'amount', value: 1500 }, 900)).toBe(900)
    expect(discountOffSen({ kind: 'amount', value: 500 }, 0)).toBe(0)
    expect(discountOffSen(null, 900)).toBe(0)
  })
})

describe('lineDiscounts', () => {
  it('the catalog discount first, then the item discount on what is left', () => {
    expect(lineDiscounts({ unitPriceSen: 2500, qty: 1, catalogDiscountBp: 5000, discount: { kind: 'percent', value: 1000 } }))
      .toEqual({ grossSen: 2500, catalogDiscountSen: 1250, itemDiscountSen: 125, netSen: 1125 })
  })
})

describe('shareBillDiscount', () => {
  it('rounds each share down and gives the leftover to the largest line first', () => {
    expect(shareBillDiscount(1000, [3000, 1000, 500])).toEqual([667, 222, 111])
  })
  it('never takes a line below zero', () => {
    expect(shareBillDiscount(2, [1, 1, 1])).toEqual([1, 1, 0])
  })
  it('nothing to share', () => {
    expect(shareBillDiscount(0, [100, 200])).toEqual([0, 0])
    expect(shareBillDiscount(100, [0, 0])).toEqual([0, 0])
  })
})
