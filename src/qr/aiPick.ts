// src/qr/aiPick.ts
/** The cart's AI Pick (spec 2026-11-22-qr-ai-pick-mascot-design.md §3): one suggestion from our own sales
 *  picks and a few rules, with a pre-written line. Pure. The card takes `{ product, sentence }`; a later
 *  source may replace the sentence (falling back to this one). */
import { defaultLine, findProduct, validateLine, type CategoryKind, type PosMenu, type PosProduct } from '../features/pos/order/cart'
import type { MenuPicks } from '../features/pos/order/picks'
import { lineAvailable, type CartLine } from './qrCart'
import { aiPickSentence, type Situation } from './aiPickCopy'

export interface AiPick { product: PosProduct; sentence: string; situation: Situation }

/** product id → its category's kind; a product whose category has none is absent. */
export function kindsOf(menu: PosMenu): Map<string, CategoryKind> {
  const out = new Map<string, CategoryKind>()
  for (const c of menu.categories) if (c.kind) for (const p of c.products) out.set(p.id, c.kind)
  return out
}

/** From MY lines (the caller passes the available ones): drinks only, food only, one unit in the whole
 *  table cart, or mixed. In that order, so a lone drink is drinks_only. */
export function situationOf(mine: readonly CartLine[], all: readonly CartLine[], kinds: ReadonlyMap<string, CategoryKind>): Situation {
  if (mine.length > 0 && mine.every((l) => kinds.get(l.productId) === 'drink')) return 'drinks_only'
  if (mine.length > 0 && mine.every((l) => kinds.get(l.productId) === 'food')) return 'food_only'
  if (all.reduce((n, l) => n + l.qty, 0) === 1) return 'solo_small'
  return 'mixed'
}

/** The card's Add opens the item page instead of adding: several sizes, or a choice the guest must make
 *  (a group with a minimum, or a default line the server would refuse). Optional add-ons do not count. */
export const aiPickOpens = (p: PosProduct): boolean =>
  p.variants.length > 1 || p.groups.some((g) => g.min > 0) || validateLine(p, defaultLine(p)) !== null

/** Can the card offer it at all: on the menu now (its catalog and time slot), not sold out, with a price,
 *  and either addable as it is or openable for a choice. */
const offerable = (p: PosProduct | undefined): p is PosProduct =>
  p !== undefined && !p.soldOut && p.variants.length > 0

/**
 * The suggestion for this guest's cart, or null (no picks, no lines of mine, nothing left to offer).
 * `all` is the whole table cart: nothing in it is suggested. `seed` is fixed per visit.
 */
export function aiPick(
  menu: PosMenu, picks: MenuPicks | null, mine: readonly CartLine[], all: readonly CartLine[],
  kinds: ReadonlyMap<string, CategoryKind>, seed: number,
): AiPick | null {
  if (!picks) return null
  const mineOk = mine.filter((l) => lineAvailable(menu, l))
  if (mineOk.length === 0) return null
  const situation = situationOf(mineOk, all.filter((l) => lineAvailable(menu, l)), kinds)
  const want: CategoryKind | null = situation === 'drinks_only' ? 'food' : situation === 'food_only' ? 'drink' : null
  const inCart = new Set(all.map((l) => l.productId))
  const pairIds: string[] = []
  for (const l of mineOk) for (const id of picks.pairs[l.productId] ?? []) if (!pairIds.includes(id)) pairIds.push(id)
  const first = (ids: readonly string[]): PosProduct | null => {
    for (const id of ids) {
      if (inCart.has(id) || (want && kinds.get(id) !== want)) continue
      const p = findProduct(menu, id)
      if (offerable(p)) return p
    }
    return null
  }
  const product = first(pairIds) ?? first(picks.popular)
  if (!product) return null
  return { product, situation, sentence: aiPickSentence(situation, product.id, product.name, seed) }
}
