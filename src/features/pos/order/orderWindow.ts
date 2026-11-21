// src/features/pos/order/orderWindow.ts
/** The outlet's ordering window (W7 spec §3): QR ordering stops outside Orders open at … Last order at,
 *  Malaysia time; the window may cross midnight (09:00–02:00). pos_orders_open
 *  (supabase/migration-2026-11-22-pos-feedme-habits.sql) decides on the server; this mirrors it for the
 *  screen only. Times are "HH:MM"; both null = no limit. Pure. */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export const WINDOW_HELP = 'QR ordering stops outside these times. Staff can still order on the POS.'
export const SET_BOTH = 'Set both times or neither.'
export const SAME_TIMES = 'Orders open at and Last order at must be different times.'

/** "21:30" → 1290; null for anything that is not HH:MM. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = hhmm ? HHMM.exec(hhmm) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** The minute of the day in Malaysia (UTC+8, no daylight saving), whatever the device's own zone. */
export function myMinuteOfDay(at: Date): number {
  const m = Math.floor(at.getTime() / 60_000) + 8 * 60
  return ((m % 1440) + 1440) % 1440
}

/** pos_orders_open's rule: from the opening minute to the end of the last-order minute; a window that opens
 *  later than it closes runs past midnight. No (or a broken) time = always open. */
export function ordersOpen(openAt: string | null, lastAt: string | null, at: Date): boolean {
  const o = minutesOf(openAt)
  const l = minutesOf(lastAt)
  if (o === null || l === null) return true
  const m = myMinuteOfDay(at)
  return o <= l ? m >= o && m <= l : m >= o || m <= l
}

/** pos_orders_closed_message's sentence: "Last orders were at 21:30. Ordering opens again at 09:00." */
export const lastOrderMessage = (openAt: string, lastAt: string): string =>
  `Last orders were at ${lastAt}. Ordering opens again at ${openAt}.`

/** The POS order pad's thin banner: "Past last order (21:30)". */
export const pastLastOrder = (lastAt: string): string => `Past last order (${lastAt})`

/** What the QR page says now: the sentence outside the window; null inside it or with no window. */
export function qrClosedMessage(openAt: string | null, lastAt: string | null, at: Date): string | null {
  if (!openAt || !lastAt || ordersOpen(openAt, lastAt, at)) return null
  return lastOrderMessage(openAt, lastAt)
}

/** The POS order pad's banner now; null inside the window or with no window. Outside it the pad says which event is
 *  nearer on the 24-hour circle: after the last order it reads "Past last order (21:30)", and in the hours before
 *  the opening time it reads "Orders open at 09:00". Compares the minutes since the last order with the minutes
 *  until opening; a tie says Past last order. The POS still orders. */
export function padPastLastOrder(openAt: string | null, lastAt: string | null, at: Date): string | null {
  if (!openAt || !lastAt || ordersOpen(openAt, lastAt, at)) return null
  const o = minutesOf(openAt)
  const l = minutesOf(lastAt)
  if (o === null || l === null) return null
  const m = myMinuteOfDay(at)
  const sinceLast = (((m - l) % 1440) + 1440) % 1440
  const untilOpen = (((o - m) % 1440) + 1440) % 1440
  return untilOpen < sinceLast ? `Orders open at ${openAt}` : pastLastOrder(lastAt)
}

/** The settings check (save_receipt_settings refuses the same): both times or neither, and not the same time. */
export function orderWindowProblem(openAt: string | null, lastAt: string | null): string | null {
  if (!openAt && !lastAt) return null
  if (!openAt || !lastAt) return SET_BOTH
  if (minutesOf(openAt) === minutesOf(lastAt)) return SAME_TIMES
  return null
}

/** A Postgres time ("09:00:00") as "HH:MM"; null stays null. */
export const hhmm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null)
