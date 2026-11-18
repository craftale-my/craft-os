// POS → Reports: words and numbers as the screen shows them (spec §5). Pure.
import { formatSen } from '../order/cart'
import { daysIn, type DateRange } from './reportRange'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export const ORDER_TYPE_LABELS: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway' }
export const SOURCE_LABELS: Record<string, string> = { counter: 'Counter', qr: 'QR' }
export const PAYMENT_KIND_LABELS: Record<string, string> = {
  cash: 'Cash', card: 'Card', duitnow: 'DuitNow', ewallet: 'E-wallet', other: 'Other',
}
export const DISCOUNT_ACTION_LABELS: Record<string, string> = { set: 'Set', clear: 'Cleared', split: 'Split' }

/** '+12%', '-10%', '0%' against the previous period; '—' when the previous period is 0. */
export function changeText(current: number, previous: number): string {
  if (previous === 0) return '—'
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}

export function average(totalSen: number, count: number): number {
  return count > 0 ? Math.round(totalSen / count) : 0
}

/** 600 → '6%'. */
export function rateLabel(bp: number): string {
  return `${bp / 100}%`
}

/** A discount as logged: a percent in basis points, an amount in sen. */
export function discountValueText(kind: string | null, value: number | null): string {
  if (value === null) return '—'
  if (kind === 'percent') return rateLabel(value)
  if (kind === 'amount') return formatSen(value)
  return '—'
}

/** '2026-01-05' → 'Mon 5 Jan 2026'. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** '2026-01-05' → 'Mon 5 Jan'. */
export function dayShort(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** An ISO time as '6 Jan 2026, 01:30', Malaysia time. */
export function reportTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3_600_000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 9 → '09:00–09:59'. */
export function hourLabel(hour: number): string {
  return `${pad(hour)}:00–${pad(hour)}:59`
}

export function rangeText(r: DateRange): string {
  return r.from === r.to ? dayLabel(r.from) : `${dayLabel(r.from)} – ${dayLabel(r.to)}`
}

/** Nett sales per business day of the range, every day present, the outlets of one day added up. */
export function dailySeries(rows: { day: string; nettSen: number }[], r: DateRange): { day: string; nettSen: number }[] {
  const byDay = new Map<string, number>()
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.nettSen)
  return daysIn(r).map((day) => ({ day, nettSen: byDay.get(day) ?? 0 }))
}

/** Bar heights in percent of the largest value, one decimal; a negative value draws no bar. */
export function barPercents(values: number[]): number[] {
  const max = Math.max(0, ...values)
  return values.map((v) => (max > 0 ? Math.round((Math.max(0, v) / max) * 1000) / 10 : 0))
}
