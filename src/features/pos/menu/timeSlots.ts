// src/features/pos/menu/timeSlots.ts
/** Time slots (spec §3, M3): when a product may be sold. Pure, so every rule is tested —
 *  against the very vectors the server's menu_window_open is checked with
 *  (slotVectors.json; supabase/migration-2026-10-24-pos-slots-photos-verify.sql carries a copy).
 *  Malaysia keeps UTC+8 all year (no daylight saving), so the shop clock is UTC + 8 h. */

/** One window of a schedule: ISO days (1 = Mon … 7 = Sun) and "HH:MM" times. Both the start
 *  and the end minute are inside ("10:00–23:59" runs to midnight, Feedme's way). An end before
 *  the start crosses midnight; `days` are the days the window starts on. */
export interface SlotWindow { days: number[]; start: string; end: string }
/** The shop's day of the week (1 = Mon … 7 = Sun) and minute of the day (0–1439). */
export interface ShopClock { isoDay: number; minute: number }

const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
export const MAX_WINDOWS = 10

/** The Malaysian day and minute at `at` (seconds dropped, as the server does). */
export function malaysiaClock(at: Date): ShopClock {
  const t = new Date(at.getTime() + MALAYSIA_OFFSET_MS)
  return { isoDay: ((t.getUTCDay() + 6) % 7) + 1, minute: t.getUTCHours() * 60 + t.getUTCMinutes() }
}

/** "08:00" → 480; null unless it is HH:MM from 00:00 to 23:59. */
export function parseHm(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const prevDay = (d: number) => (d === 1 ? 7 : d - 1)

/** Whether one window is open at the shop clock (menu_window_open). */
export function windowOpen(w: SlotWindow, c: ShopClock): boolean {
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  if (s === null || e === null || s === e) return false
  if (s < e) return w.days.includes(c.isoDay) && c.minute >= s && c.minute <= e
  return (w.days.includes(c.isoDay) && c.minute >= s) || (w.days.includes(prevDay(c.isoDay)) && c.minute <= e)
}

/** No windows = always available; otherwise available inside any one of them (menu_product_open). */
export function availableAt(windows: SlotWindow[], at: Date): boolean {
  if (windows.length === 0) return true
  const c = malaysiaClock(at)
  return windows.some((w) => windowOpen(w, c))
}

/** What the counter shows on a product outside its slots: the next window that opens later
 *  today ("Available 08:00–11:30"), else "Not available now". null while it is available. */
export function slotLabel(windows: SlotWindow[], at: Date): string | null {
  if (availableAt(windows, at)) return null
  const c = malaysiaClock(at)
  const next = windows
    .filter((w) => w.days.includes(c.isoDay) && (parseHm(w.start) ?? -1) > c.minute)
    .sort((a, b) => (parseHm(a.start) ?? 0) - (parseHm(b.start) ?? 0))[0]
  return next ? `Available ${next.start}–${next.end}` : 'Not available now'
}

/** pos_insert_order's words for a product outside its slots. */
export const notAvailableNow = (name: string) => `${name} is not available at this time`

/** "Daily", "Mon–Fri", "Sat, Sun", "Mon, Wed–Fri". */
export function daysLabel(days: number[]): string {
  const set = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b)
  if (set.length === 7) return 'Daily'
  if (set.length === 0) return 'No days'
  const runs: [number, number][] = []
  for (const d of set) {
    const last = runs[runs.length - 1]
    if (last && d === last[1] + 1) last[1] = d
    else runs.push([d, d])
  }
  const name = (d: number) => DAY_NAMES[d - 1]
  return runs.map(([a, b]) => (a === b ? name(a) : b === a + 1 ? `${name(a)}, ${name(b)}` : `${name(a)}–${name(b)}`)).join(', ')
}

/** "Mon–Fri · 08:00–11:30", "Fri, Sat · 22:00–02:00 (next day)". */
export function windowLabel(w: SlotWindow): string {
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  return `${daysLabel(w.days)} · ${w.start}–${w.end}${s !== null && e !== null && e < s ? ' (next day)' : ''}`
}

/** menu_save_schedule's words for one window, or null. */
export function windowProblem(w: SlotWindow): string | null {
  if (w.days.length === 0) return 'Pick at least one day for each time window'
  if (parseHm(w.start) === null || parseHm(w.end) === null) return 'Enter each time as HH:MM, e.g. 08:00'
  if (w.start === w.end) return 'A time window cannot start and end at the same time'
  return null
}
