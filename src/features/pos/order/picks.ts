// src/features/pos/order/picks.ts
/** Menu picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md): the payload qr_picks and
 *  pos_menu_picks return, and the pure rules that keep each hint to what the menu offers now.
 *  The server counts; the client only filters. Hints never block ordering: no payload = no hints. */
import { findProduct, type OrderLine, type PosMenu, type PosProduct } from './cart'

export interface MenuPicks {
  /** product ids: recommended first, then by units sold (the server sends up to 12) */
  popular: string[]
  /** product id → the products usually ordered with it (the server sends up to 6 each) */
  pairs: Record<string, string[]>
  /** product id → add-on group id → the option most guests choose */
  mostPicked: Record<string, Record<string, string>>
  /** false = Popular is only the recommended products so far */
  fromSales: boolean
}

/** Popular here shows at most this many products (the server sends up to 12 so filtering still leaves 8). */
export const MAX_POPULAR = 8

/** Goes well with shows at most this many products. */
export const MAX_PAIRS = 3

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])

/** The server's reply → MenuPicks, or null when it is not one (an unknown or paused table answers null). */
export function parsePicks(data: unknown): MenuPicks | null {
  if (!isRecord(data) || !Array.isArray(data.popular) || !isRecord(data.pairs) || !isRecord(data.mostPicked)) return null
  const pairs: Record<string, string[]> = {}
  for (const [id, ids] of Object.entries(data.pairs)) pairs[id] = strings(ids)
  const mostPicked: Record<string, Record<string, string>> = {}
  for (const [id, groups] of Object.entries(data.mostPicked)) {
    if (!isRecord(groups)) continue
    const m: Record<string, string> = {}
    for (const [groupId, optionId] of Object.entries(groups)) if (typeof optionId === 'string') m[groupId] = optionId
    mostPicked[id] = m
  }
  return { popular: strings(data.popular), pairs, mostPicked, fromSales: data.fromSales === true }
}

/** On this menu now (its catalog and time slot), not sold out, with a price. */
const orderable = (p: PosProduct | undefined): p is PosProduct => p !== undefined && !p.soldOut && p.variants.length > 0

/** Popular here: the popular products the menu offers now, in the server's order. */
export function visiblePopular(menu: PosMenu, picks: MenuPicks | null): PosProduct[] {
  if (!picks) return []
  return picks.popular.map((id) => findProduct(menu, id)).filter(orderable).slice(0, MAX_POPULAR)
}

/** Goes well with `productId`: its pairs the menu offers now, not in the cart, at most MAX_PAIRS. */
export function pairsFor(menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[]): PosProduct[] {
  if (!picks) return []
  const inCart = new Set(cart.map((l) => l.productId))
  return (picks.pairs[productId] ?? [])
    .filter((id) => id !== productId && !inCart.has(id))
    .map((id) => findProduct(menu, id))
    .filter(orderable)
    .slice(0, MAX_PAIRS)
}

/** The QR page offers Goes well with after a new line of `productId` when there is something to
 *  show and it has not been shown for that product in this visit (`shown`). */
export function offerPairs(
  menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[], shown: ReadonlySet<string>,
): boolean {
  return !shown.has(productId) && pairsFor(menu, picks, productId, cart).length > 0
}

/** Most picked of one product: group id → option id. The sheets mark that option; nothing is chosen for the guest. */
export function mostPickedFor(picks: MenuPicks | null, productId: string): Readonly<Record<string, string>> | undefined {
  return picks?.mostPicked[productId]
}

/** The Goes well with panel / chip row is about a product that must still be in the cart. */
export function goesWellVisible(productId: string | null, cart: readonly OrderLine[]): boolean {
  return productId !== null && cart.some((l) => l.productId === productId)
}
