import type { CostStatus } from '../types'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Packs + loose base units → base units (3 dp). Both blank = null. */
export function packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null {
  if (packs == null && loose == null) return null
  return round3((packs ?? 0) * rate + (loose ?? 0))
}

/** Base units → whole packs and the rest. Negative quantities stay loose. */
export function baseToPacksLoose(base: number, rate: number): { packs: number; loose: number } {
  if (rate === 1) return { packs: base, loose: 0 }
  if (base < 0) return { packs: 0, loose: round3(base) }
  const packs = Math.floor(base / rate + 1e-9)
  const loose = round3(base - packs * rate)
  return { packs, loose: loose < 0 ? 0 : loose }
}

/** Cost of one line in RM; null when the ingredient has no cost. */
export function lineCost(qtyBase: number, unitCost: number | null | undefined): number | null {
  return unitCost == null ? null : qtyBase * unitCost
}

/** Total recipe cost; null when any line has no cost. */
export function recipeCost(lines: { qtyBase: number; unitCost: number | null | undefined }[]): { cost: number | null; missing: number } {
  let total = 0
  let missing = 0
  for (const l of lines) {
    const c = lineCost(l.qtyBase, l.unitCost)
    if (c == null) missing += 1
    else total += c
  }
  return { cost: missing > 0 ? null : Math.round(total * 10000) / 10000, missing }
}

/** Food cost in basis points: cost (RM) ÷ price (sen). */
export function foodCostBp(costRm: number | null, priceSen: number): number | null {
  if (costRm == null || priceSen <= 0) return null
  return Math.round((costRm * 1000000) / priceSen)
}

export function costStatus(v: {
  lineCount: number; missing: number; priceSen: number; foodCostBp: number | null; targetBp: number | null
}): CostStatus {
  if (v.lineCount === 0) return 'no_recipe'
  if (v.missing > 0) return 'missing_cost'
  if (v.priceSen <= 0) return 'no_price'
  if (v.targetBp != null && v.foodCostBp != null && v.foodCostBp > v.targetBp) return 'over_target'
  return 'ok'
}

export function formatBp(bp: number | null): string {
  return bp == null ? '—' : `${(bp / 100).toFixed(1)}%`
}

/** True when two recipes hold the same items with the same quantities (order ignored). */
export function sameRecipeLines(
  a: { item_id: string; qty_base: number }[],
  b: { item_id: string; qty_base: number }[],
): boolean {
  if (a.length !== b.length) return false
  const m = new Map(b.map(l => [l.item_id, l.qty_base]))
  return a.every(l => m.has(l.item_id) && m.get(l.item_id) === l.qty_base)
}
