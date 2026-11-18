// POS → Reports: the business days asked for and the filter kept in the page URL (spec §3). Pure.
// A business day runs from 06:00 to 05:59 the next morning, Malaysia time (UTC+8, no daylight saving),
// so the business day of an instant is the UTC calendar date of that instant plus 2 hours.

export type Preset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month'
export type ReportTab =
  | 'overview' | 'summary' | 'daily' | 'hourly' | 'products' | 'payments'
  | 'sst' | 'discounts' | 'voids' | 'refunds' | 'drawer' | 'ledger'

/** Whole business days, both counted: 'YYYY-MM-DD'. */
export interface DateRange {
  from: string
  to: string
}
export interface ReportFilter extends DateRange {
  outlets: string[]
  tab: ReportTab
}
/** What the filter needs of my_outlets(). */
export interface OutletChoice {
  id: string
  isHome: boolean
}

export const MAX_DAYS = 366

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'this_week', label: 'This week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
]

export const TABS: { id: ReportTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'summary', label: 'Sales summary' },
  { id: 'daily', label: 'Daily sales' },
  { id: 'hourly', label: 'Hourly sales' },
  { id: 'products', label: 'Products' },
  { id: 'payments', label: 'Payments' },
  { id: 'sst', label: 'SST' },
  { id: 'discounts', label: 'Discounts' },
  { id: 'voids', label: 'Voids' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'drawer', label: 'Cash drawer' },
  { id: 'ledger', label: 'Ledger export' },
]

const DAY_MS = 86_400_000
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** 'YYYY-MM-DD' naming a real date. */
export function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = toTime(s)
  return !Number.isNaN(t) && toDay(t) === s
}

export function addDays(day: string, n: number): string {
  return toDay(toTime(day) + n * DAY_MS)
}

/** Whole days from `from` to `to`, both counted. */
export function dayCount(r: DateRange): number {
  return Math.round((toTime(r.to) - toTime(r.from)) / DAY_MS) + 1
}

export function daysIn(r: DateRange): string[] {
  return Array.from({ length: Math.max(0, dayCount(r)) }, (_, i) => addDays(r.from, i))
}

/** The business day an instant belongs to. */
export function businessDay(at: Date): string {
  return toDay(at.getTime() + 2 * 3_600_000)
}

function lastDayOfMonth(first: string): string {
  const d = new Date(toTime(first))
  return toDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

export function presetRange(p: Preset, now: Date): DateRange {
  const today = businessDay(now)
  const firstOfMonth = `${today.slice(0, 7)}-01`
  switch (p) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case 'this_week': {
      const monday = addDays(today, -((new Date(toTime(today)).getUTCDay() + 6) % 7))
      return { from: monday, to: addDays(monday, 6) }
    }
    case 'this_month':
      return { from: firstOfMonth, to: lastDayOfMonth(firstOfMonth) }
    case 'last_month': {
      const first = `${addDays(firstOfMonth, -1).slice(0, 7)}-01`
      return { from: first, to: lastDayOfMonth(first) }
    }
  }
}

/** The preset a range is, or 'custom'. */
export function presetOf(r: DateRange, now: Date): Preset | 'custom' {
  const hit = PRESETS.find((p) => {
    const x = presetRange(p.id, now)
    return x.from === r.from && x.to === r.to
  })
  return hit ? hit.id : 'custom'
}

/** The period of the same length just before (the Overview's comparison). */
export function previousRange(r: DateRange): DateRange {
  const n = dayCount(r)
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) }
}

/** Why a range cannot be asked for — the server's words — or null. */
export function rangeProblem(r: DateRange): string | null {
  if (!isDay(r.from) || !isDay(r.to)) return 'Choose a valid date range.'
  if (r.from > r.to) return 'The start date is after the end date.'
  if (dayCount(r) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days.`
  return null
}

/** HQ (all_branches) starts on every outlet; anyone else on their home outlet, or their first. */
export function defaultOutlets(outlets: OutletChoice[], isHq: boolean): string[] {
  if (isHq) return outlets.map((o) => o.id)
  const home = outlets.find((o) => o.isHome) ?? outlets[0]
  return home ? [home.id] : []
}

/** The filter of the page URL: unknown outlets dropped, a bad range → today, a bad tab → Overview. */
export function readFilter(params: URLSearchParams, outlets: OutletChoice[], isHq: boolean, now: Date): ReportFilter {
  const known = new Set(outlets.map((o) => o.id))
  const asked = [...new Set((params.get('outlets') ?? '').split(',').filter((id) => known.has(id)))]
  const range = { from: params.get('from') ?? '', to: params.get('to') ?? '' }
  const { from, to } = rangeProblem(range) === null ? range : presetRange('today', now)
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview'
  return { outlets: asked.length > 0 ? asked : defaultOutlets(outlets, isHq), from, to, tab }
}

export function filterParams(f: ReportFilter): URLSearchParams {
  return new URLSearchParams({ outlets: f.outlets.join(','), from: f.from, to: f.to, tab: f.tab })
}
