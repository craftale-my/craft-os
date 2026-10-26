// src/features/pos/order/posScreen.ts
/** PosPage's screen decisions, kept pure so they are tested on their own. */
import type { OrderLine } from './cart'
import type { OpenBillRow, TableRow } from './posApi'
import type { BillSummary } from './billSummaries'
import { QUEUED_NOT_SENT } from './billView'
import { targetKey, type OrderTarget } from './orderTarget'

/** Which POS screen is up. An order screen is keyed by its session and its table or takeaway bill
 *  (targetKey): Select pax keeps the screen, a move or merge starts it again on the new bill, so
 *  unsent drafts never follow onto another bill; a new session (opened from home, Payment's
 *  Cancel) starts clean. */
export type Screen =
  | { kind: 'home' }
  | { kind: 'order'; session: number; target: OrderTarget; lines?: OrderLine[]; catalogId?: string | null }
  | { kind: 'payment'; bill: OpenBillRow; back: OrderTarget }
  | { kind: 'transaction' }

/** True only while the order screen of that session is up: a late callback from a screen the
 *  cashier already left must not move them. */
export const onSession = (s: Screen, session: number): boolean => s.kind === 'order' && s.session === session

/** The order screen of `session` now targets `t`. Same table or bill (pax chosen): the screen stays.
 *  Another bill (move, merge): it starts again there without its lines or catalog (`restarted`).
 *  Any other screen, or another session: unchanged. */
export function retarget(s: Screen, session: number, t: OrderTarget): { screen: Screen; restarted: boolean } {
  if (s.kind !== 'order' || s.session !== session) return { screen: s, restarted: false }
  if (targetKey(t) === targetKey(s.target)) return { screen: { ...s, target: t }, restarted: false }
  return { screen: { kind: 'order', session, target: t }, restarted: true }
}

export const SENT_BILL_NOT_LOADED = 'The order was sent, but its bill could not be loaded — open the table from the home screen to take payment.'
export const SENT_BILL_CLOSED = 'This bill is no longer open — check it on the home screen.'

/** What Send & pay does once the order's bill was looked up: `billId` null when the order is still
 *  only in this iPad's queue or the lookup failed (offline); `fresh` null when the bills could not
 *  be read. Payment opens only on the open bill the order landed on; otherwise home with a notice,
 *  never the order screen with an empty cart the cashier might enter again. */
export function payOutcome(billId: string | null, fresh: OpenBillRow[] | null, target: OrderTarget):
  { kind: 'payment'; bill: OpenBillRow; back: OrderTarget } | { kind: 'home'; notice: string } {
  if (!billId) return { kind: 'home', notice: QUEUED_NOT_SENT }
  if (!fresh) return { kind: 'home', notice: SENT_BILL_NOT_LOADED }
  const bill = fresh.find((b) => b.id === billId)
  if (!bill) return { kind: 'home', notice: SENT_BILL_CLOSED }
  return { kind: 'payment', bill, back: target.kind === 'takeaway' ? { kind: 'takeaway', billId } : target }
}

/** How long Send & pay waits for the order's bill lookup and the reload after it, together. */
export const SEND_PAY_WAIT_MS = 8_000

const EXPIRED: unique symbol = Symbol('expired')

/** One deadline shared by several awaits: `race` gives the promise's value if it answers before the
 *  deadline, else `fallback` (the promise keeps running, its late answer is ignored). Send & pay
 *  races the lookup and the reload against it, so a stalled network ends in the safe "not found"
 *  path instead of a screen stuck on Sending. `clear` stops the timer. */
export function deadline(ms: number): { race: <T>(p: Promise<T>, fallback: T) => Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), ms) })
  return {
    race: async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      const r = await Promise.race([p, expired])
      return r === EXPIRED ? fallback : (r as T)
    },
    clear: () => clearTimeout(timer),
  }
}

/** PosPage's reload: tables and open bills are needed, the bill summaries are not (a tile without a
 *  total still renders). A failed summaries read keeps the last ones (`summaries` null); a failed
 *  tables or bills read is the error shown. */
export function settleReload(
  tables: PromiseSettledResult<TableRow[]>,
  bills: PromiseSettledResult<OpenBillRow[]>,
  summaries: PromiseSettledResult<Map<string, BillSummary>>,
): { ok: true; tables: TableRow[]; bills: OpenBillRow[]; summaries: Map<string, BillSummary> | null } | { ok: false; error: string } {
  if (tables.status === 'rejected') return { ok: false, error: reason(tables.reason) }
  if (bills.status === 'rejected') return { ok: false, error: reason(bills.reason) }
  return { ok: true, tables: tables.value, bills: bills.value, summaries: summaries.status === 'fulfilled' ? summaries.value : null }
}
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))
