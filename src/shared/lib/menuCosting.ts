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
  // Unrounded: food cost % must match the database view to the basis point. Round only for display.
  return { cost: missing > 0 ? null : total, missing }
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

/** The text in a row's pack and loose boxes while it is being edited. */
export interface QtyDraft { packs: string; loose: string }

/** What the boxes show for a stored quantity (sign is shown by the Adds / Removes chip). */
export function draftFromBase(base: number, rate: number): QtyDraft {
  const s = baseToPacksLoose(Math.abs(base), rate)
  return { packs: s.packs ? String(s.packs) : '', loose: s.loose ? String(s.loose) : '' }
}

export type DraftCommit = { ok: true; base: number } | { ok: false; message: string }

function parseBox(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/**
 * Turns a row's draft into a signed base quantity, reading both boxes together
 * (so "0 packs + 150 g" is 150, not the old packs plus 150). Invalid or empty
 * drafts are refused; the caller keeps the previous quantity and shows the message.
 */
export function commitQtyDraft(draft: QtyDraft, rate: number, negative: boolean): DraftCommit {
  const single = rate === 1
  const p = parseBox(draft.packs)
  const l = single ? null : parseBox(draft.loose)
  if (Number.isNaN(p) || Number.isNaN(l)) return { ok: false, message: 'Enter a number, 0 or more.' }
  const base = packsLooseToBase(p, l, rate)
  if (base == null || base === 0) return { ok: false, message: 'Quantity cannot be empty. Use Remove to drop this ingredient.' }
  return { ok: true, base: negative ? -base : base }
}

/**
 * How a recipe's total should read. A cost that has not arrived yet (or failed to
 * load) is absent from the map; an ingredient with no price is present as null.
 */
export type CostDisplay = 'empty' | 'loading' | 'failed' | 'missing_price' | 'ok'
export function costDisplay(
  itemIds: string[], costs: Map<string, number | null>, failed: Set<string>,
): CostDisplay {
  if (itemIds.length === 0) return 'empty'
  const absent = itemIds.filter(id => !costs.has(id))
  if (absent.some(id => failed.has(id))) return 'failed'
  if (absent.length > 0) return 'loading'
  return itemIds.some(id => costs.get(id) == null) ? 'missing_price' : 'ok'
}
