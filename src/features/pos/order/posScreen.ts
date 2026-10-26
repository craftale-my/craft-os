// src/features/pos/order/posScreen.ts
/** PosPage's screen decisions, kept pure so they are tested on their own. */
import type { OrderLine } from './cart'
import type { OpenBillRow } from './posApi'
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

export const SENT_BILL_NOT_LOADED = 'The order reached the kitchen, but its bill could not be loaded — take payment from the home screen.'
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
