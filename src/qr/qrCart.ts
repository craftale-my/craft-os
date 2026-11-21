// src/qr/qrCart.ts
/** The table's shared cart, as the QR page reads it (spec 2026-11-22-qr-shared-table-cart-design.md).
 *  Pure: the server holds the lines; this groups them, judges them against the menu and words the toast. */
import { findProduct, linePriceSen, type OrderLine, type PosMenu } from '../features/pos/order/cart'
import { avatarEmoji } from './qrGuest'

export interface CartLine extends OrderLine { id: string; guestId: string; guestLabel: string; guestAvatar: string }
export interface CartState { version: string; lines: CartLine[] }
export interface GuestGroup { guestId: string; label: string; avatar: string; isMe: boolean; lines: CartLine[] }
/** an item of qr_table_state: already sent */
export interface OrderedItem {
  name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean
  guestLabel?: string | null; guestAvatar?: string | null
}
export interface OrderedGroup { label: string | null; avatar: string | null; items: OrderedItem[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** qr_cart_state's reply, or null for anything else. */
export function parseCart(data: unknown): CartState | null {
  if (!isObj(data) || typeof data.version !== 'string' || !Array.isArray(data.lines)) return null
  const lines: CartLine[] = []
  for (const l of data.lines as unknown[]) {
    if (!isObj(l) || typeof l.id !== 'string' || typeof l.guestId !== 'string' || typeof l.productId !== 'string'
        || typeof l.variantId !== 'string' || typeof l.qty !== 'number') return null
    lines.push({
      id: l.id, guestId: l.guestId,
      guestLabel: typeof l.guestLabel === 'string' ? l.guestLabel : 'Guest',
      guestAvatar: typeof l.guestAvatar === 'string' ? l.guestAvatar : 'a1',
      productId: l.productId, variantId: l.variantId, qty: l.qty,
      note: typeof l.note === 'string' ? l.note : null,
      optionIds: Array.isArray(l.optionIds) ? l.optionIds.filter((x): x is string => typeof x === 'string') : [],
    })
  }
  return { version: data.version, lines }
}

/** Can this line be ordered from the menu the phone holds now? Every phone holds the same menu. */
export function lineAvailable(menu: PosMenu, line: OrderLine): boolean {
  const p = findProduct(menu, line.productId)
  if (!p || p.soldOut) return false
  if (!p.variants.some((v) => v.id === line.variantId)) return false
  const offered = new Map(p.groups.flatMap((g) => g.options.map((o) => [o.id, o.available] as const)))
  return line.optionIds.every((id) => offered.get(id) === true)
}

function byGuest(lines: CartLine[], myGuestId: string): GuestGroup[] {
  const out: GuestGroup[] = []
  for (const l of lines) {
    let g = out.find((x) => x.guestId === l.guestId)
    if (!g) {
      g = { guestId: l.guestId, label: l.guestLabel, avatar: l.guestAvatar, isMe: l.guestId === myGuestId, lines: [] }
      out.push(g)
    }
    g.lines.push(l)
  }
  return out
}

/** The cart panel: my lines, then the others' by guest in order of their first line. */
export function groupCart(lines: CartLine[], myGuestId: string): { mine: CartLine[]; others: GuestGroup[] } {
  const all = byGuest(lines, myGuestId)
  return { mine: all.find((g) => g.isMe)?.lines ?? [], others: all.filter((g) => !g.isMe) }
}

/** The send sheet: what will be sent, by guest, me first. */
export function sendGroups(menu: PosMenu, lines: CartLine[], myGuestId: string): GuestGroup[] {
  const all = byGuest(lines.filter((l) => lineAvailable(menu, l)), myGuestId)
  return [...all.filter((g) => g.isMe), ...all.filter((g) => !g.isMe)]
}

/** p_skip for qr_cart_send. */
export const skipIds = (menu: PosMenu, lines: CartLine[]): string[] =>
  lines.filter((l) => !lineAvailable(menu, l)).map((l) => l.id)

export function cartTotalSen(menu: PosMenu, lines: CartLine[]): number {
  let total = 0
  for (const l of lines) {
    if (!lineAvailable(menu, l)) continue
    const p = findProduct(menu, l.productId)
    total += (p ? linePriceSen(p, l) ?? 0 : 0) * l.qty
  }
  return total
}

/** What to tell this guest about lines the others added since the last read; null = nothing. */
export function additionsToast(before: CartState | null, after: CartState, myGuestId: string, menu: PosMenu): string | null {
  if (!before) return null
  const known = new Set(before.lines.map((l) => l.id))
  const added = after.lines.filter((l) => !known.has(l.id) && l.guestId !== myGuestId)
  if (added.length === 0) return null
  const units = added.reduce((n, l) => n + l.qty, 0)
  if (new Set(added.map((l) => l.guestId)).size > 1) return `Others at this table added ${units} items`
  const first = added[0]
  const who = `${avatarEmoji(first.guestAvatar)} ${first.guestLabel}`.trim()
  if (added.length === 1) return `${who} added ${first.qty} × ${findProduct(menu, first.productId)?.name ?? 'an item'}`
  return `${who} added ${units} items`
}

/** "Ordered so far" by guest, in order of their first item; items ordered at the counter (no guest) last. */
export function groupOrdered(items: OrderedItem[]): OrderedGroup[] {
  const out: OrderedGroup[] = []
  for (const i of items) {
    const label = i.guestLabel ?? null
    let g = out.find((x) => x.label === label)
    if (!g) { g = { label, avatar: i.guestAvatar ?? null, items: [] }; out.push(g) }
    g.items.push(i)
  }
  return [...out.filter((g) => g.label !== null), ...out.filter((g) => g.label === null)]
}

export const isNetworkError = (message: string): boolean =>
  message === 'Failed to fetch' || message === 'Load failed' || message.includes('NetworkError')

/** The table's Broadcast channel: "qr-" + the first 16 hex characters of SHA-256(token), so the token is
 *  never a channel name. */
export async function cartChannel(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return `qr-${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
