// src/features/pos/order/padSlots.ts
/** The order pad's time slots (spec §3): which products are outside their slots right now,
 *  by the server's clock. Pure; the time maths is ../menu/timeSlots.ts. */
import { notAvailableNow, slotLabel, type SlotWindow } from '../menu/timeSlots'

/** What pos_menu_windows returns. */
export interface MenuWindowsJson { now: string; windows: (SlotWindow & { productId: string })[] }
/** Windows by product (a product with none sells at any time) and how far the server's clock
 *  is ahead of this iPad's. */
export interface MenuWindows { offsetMs: number; byProduct: Map<string, SlotWindow[]> }

export const NO_WINDOWS: MenuWindows = { offsetMs: 0, byProduct: new Map() }

/** pos_menu_windows, read at `receivedAt` (this iPad's Date.now()). */
export function menuWindows(json: MenuWindowsJson, receivedAt: number): MenuWindows {
  const byProduct = new Map<string, SlotWindow[]>()
  for (const w of json.windows) {
    byProduct.set(w.productId, [...(byProduct.get(w.productId) ?? []), { days: w.days, start: w.start, end: w.end }])
  }
  const server = Date.parse(json.now)
  return { offsetMs: Number.isFinite(server) ? server - receivedAt : 0, byProduct }
}

/** The server's time, from this iPad's clock and the offset measured at the last read. */
export const serverNow = (w: MenuWindows, deviceNow: number): Date => new Date(deviceNow + w.offsetMs)

/** How far past the server's minute the pad's clock ticks: enough that a small change of the
 *  measured offset between two reads never lands the tick just before the minute. */
export const TICK_MARGIN_MS = 250

/** Milliseconds from `deviceNow` until just after the next minute begins on the server's clock
 *  (time slots open and close on the server's minute, not this iPad's). Always more than the
 *  margin and at most a minute plus the margin. */
export function msUntilServerMinute(deviceNow: number, offsetMs: number, marginMs = TICK_MARGIN_MS): number {
  const intoMinute = (((deviceNow + offsetMs) % 60_000) + 60_000) % 60_000
  return 60_000 - intoMinute + marginMs
}

/** A tile's words while the product is outside its slots ("Available 08:00–11:30"); null = on sale. */
export const tileSlotLabel = (w: MenuWindows, productId: string, at: Date): string | null =>
  slotLabel(w.byProduct.get(productId) ?? [], at)

/** pos_insert_order's words for the first cart line outside its slots at `at`, or null. */
export function slotProblem(w: MenuWindows, lines: { productId: string }[], nameOf: (productId: string) => string, at: Date): string | null {
  const late = lines.find((l) => tileSlotLabel(w, l.productId, at) !== null)
  return late ? notAvailableNow(nameOf(late.productId)) : null
}
