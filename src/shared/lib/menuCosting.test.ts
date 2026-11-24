import { describe, it, expect } from 'vitest'
import {
  packsLooseToBase, baseToPacksLoose, lineCost, recipeCost, foodCostBp, costStatus, formatBp, sameRecipeLines,
  commitQtyDraft, draftFromBase, costDisplay,
} from './menuCosting'

describe('packsLooseToBase', () => {
  it('adds packs times rate and loose, rounded to 3 dp', () => {
    expect(packsLooseToBase(3, 250, 1000)).toBe(3250)
    expect(packsLooseToBase(3, null, 1.1)).toBe(3.3)
  })
  it('returns null when both are blank', () => {
    expect(packsLooseToBase(null, null, 1000)).toBeNull()
  })
})

describe('baseToPacksLoose', () => {
  it('splits into whole packs and the rest', () => {
    expect(baseToPacksLoose(3250, 1000)).toEqual({ packs: 3, loose: 250 })
  })
  it('keeps negative quantities whole (add-on removals)', () => {
    expect(baseToPacksLoose(-200, 1000)).toEqual({ packs: 0, loose: -200 })
  })
  it('uses packs only when the rate is 1', () => {
    expect(baseToPacksLoose(7, 1)).toEqual({ packs: 7, loose: 0 })
  })
})

describe('lineCost / recipeCost', () => {
  it('multiplies quantity by unit cost', () => {
    expect(lineCost(100, 0.015)).toBeCloseTo(1.5)
  })
  it('is null without a unit cost', () => {
    expect(lineCost(100, null)).toBeNull()
    expect(lineCost(100, undefined)).toBeNull()
  })
  it('sums lines and counts missing costs; cost is null if any is missing', () => {
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.015 }, { qtyBase: 50, unitCost: 0.02 }]))
      .toEqual({ cost: 2.5, missing: 0 })
    const r = recipeCost([{ qtyBase: 100, unitCost: 0.015 }, { qtyBase: 50, unitCost: 0.02 }])
    expect(r.cost).toBeCloseTo(2.5, 10)
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.015 }, { qtyBase: 10, unitCost: null }]))
      .toEqual({ cost: null, missing: 1 })
  })
  it('handles negative add-on lines', () => {
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.01 }, { qtyBase: -100, unitCost: 0.02 }]).cost).toBeCloseTo(-1)
  })
})

describe('foodCostBp', () => {
  it('is cost over price in basis points', () => {
    expect(foodCostBp(2.5, 1000)).toBe(2500)
    expect(foodCostBp(2.5, 1200)).toBe(2083)
  })
  it('is null with no cost or no price', () => {
    expect(foodCostBp(null, 1000)).toBeNull()
    expect(foodCostBp(2.5, 0)).toBeNull()
  })
})

describe('costStatus', () => {
  const base = { lineCount: 2, missing: 0, priceSen: 1000, foodCostBp: 2500, targetBp: null }
  it('orders the checks: no recipe, missing cost, no price, over target, ok', () => {
    expect(costStatus({ ...base, lineCount: 0 })).toBe('no_recipe')
    expect(costStatus({ ...base, missing: 1, foodCostBp: null })).toBe('missing_cost')
    expect(costStatus({ ...base, priceSen: 0, foodCostBp: null })).toBe('no_price')
    expect(costStatus({ ...base, targetBp: 2000 })).toBe('over_target')
    expect(costStatus({ ...base, targetBp: 3000 })).toBe('ok')
    expect(costStatus(base)).toBe('ok')
  })
})

describe('formatBp', () => {
  it('shows one decimal percent or a dash', () => {
    expect(formatBp(2083)).toBe('20.8%')
    expect(formatBp(2500)).toBe('25.0%')
    expect(formatBp(null)).toBe('—')
  })
})

describe('sameRecipeLines', () => {
  it('compares items and quantities, ignoring order', () => {
    expect(sameRecipeLines([{ item_id: 'a', qty_base: 1 }, { item_id: 'b', qty_base: 2 }], [{ item_id: 'b', qty_base: 2 }, { item_id: 'a', qty_base: 1 }])).toBe(true)
    expect(sameRecipeLines([{ item_id: 'a', qty_base: 1 }], [{ item_id: 'a', qty_base: 2 }])).toBe(false)
    expect(sameRecipeLines([{ item_id: 'a', qty_base: 1 }], [])).toBe(false)
    expect(sameRecipeLines([], [])).toBe(true)
  })
})

describe('recipeCost precision', () => {
  it('does not round the total, so food cost % matches the database view', () => {
    // 0.00004 would vanish under 4 dp rounding and shift the bp.
    expect(recipeCost([{ qtyBase: 1, unitCost: 1.23454 }]).cost).toBe(1.23454)
    expect(foodCostBp(recipeCost([{ qtyBase: 1, unitCost: 0.00005 }]).cost, 1)).toBe(50)
  })
})

describe('commitQtyDraft', () => {
  it('reads packs and loose together: 0 packs + 150 g is 150', () => {
    expect(commitQtyDraft({ packs: '0', loose: '150' }, 1000, false)).toEqual({ ok: true, base: 150 })
    expect(commitQtyDraft({ packs: '', loose: '150' }, 1000, false)).toEqual({ ok: true, base: 150 })
    expect(commitQtyDraft({ packs: '2', loose: '150' }, 1000, false)).toEqual({ ok: true, base: 2150 })
  })
  it('refuses both blank or zero (caller keeps the previous quantity)', () => {
    expect(commitQtyDraft({ packs: '', loose: '' }, 1000, false).ok).toBe(false)
    expect(commitQtyDraft({ packs: '0', loose: '0' }, 1000, false).ok).toBe(false)
  })
  it('refuses text and negative numbers', () => {
    const r = commitQtyDraft({ packs: 'abc', loose: '' }, 1000, false)
    expect(r).toEqual({ ok: false, message: 'Enter a number, 0 or more.' })
    expect(commitQtyDraft({ packs: '', loose: '-5' }, 1000, false).ok).toBe(false)
  })
  it('applies the sign for add-on removals', () => {
    expect(commitQtyDraft({ packs: '', loose: '100' }, 1000, true)).toEqual({ ok: true, base: -100 })
  })
  it('ignores the loose box when the rate is 1', () => {
    expect(commitQtyDraft({ packs: '7', loose: '99' }, 1, false)).toEqual({ ok: true, base: 7 })
  })
  it('round-trips fractional base quantities through the boxes', () => {
    for (const [base, rate] of [[1.5, 1000], [3.3, 1.1], [2150.25, 1000], [0.125, 1], [-12.5, 500]] as const) {
      const r = commitQtyDraft(draftFromBase(base, rate), rate, base < 0)
      expect(r).toEqual({ ok: true, base })
    }
  })
})

describe('costDisplay', () => {
  const costs = new Map<string, number | null>([['a', 0.02], ['n', null]])
  it('is empty with no lines', () => {
    expect(costDisplay([], costs, new Set())).toBe('empty')
  })
  it('is loading while a cost has not arrived, failed when its fetch failed', () => {
    expect(costDisplay(['a', 'x'], costs, new Set())).toBe('loading')
    expect(costDisplay(['a', 'x'], costs, new Set(['x']))).toBe('failed')
  })
  it('tells no price apart from not loaded', () => {
    expect(costDisplay(['a', 'n'], costs, new Set())).toBe('missing_price')
    expect(costDisplay(['a'], costs, new Set())).toBe('ok')
  })
})
