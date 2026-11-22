import type { StockUsageRow, StockUsageSummary } from '../types'

const num = (v: unknown): number => Number(v ?? 0)

export function normaliseUsageRow(raw: StockUsageRow): StockUsageRow {
  return {
    ...raw,
    sold_base: num(raw.sold_base),
    sold_value: num(raw.sold_value),
    wasted_base: num(raw.wasted_base),
    wasted_value: num(raw.wasted_value),
    unexplained_base: num(raw.unexplained_base),
    unexplained_value: num(raw.unexplained_value),
    unexplained_pct: raw.unexplained_pct == null ? null : Number(raw.unexplained_pct),
    counted: raw.counted !== false,
  }
}

export function normaliseUsageSummary(raw: StockUsageSummary): StockUsageSummary {
  return {
    ...raw,
    bills_paid: num(raw.bills_paid),
    lines_without_recipe: num(raw.lines_without_recipe),
    depletion_errors: num(raw.depletion_errors),
    sold_value: num(raw.sold_value),
    wasted_value: num(raw.wasted_value),
    unexplained_value: num(raw.unexplained_value),
    rows_without_cost: num(raw.rows_without_cost),
    capped: raw.capped === true,
    depletion_started_at: raw.depletion_started_at ?? null,
    partial_period: raw.partial_period === true,
    has_pos_sales: raw.has_pos_sales === true,
  }
}

/** "−RM 2.00" / "+RM 2.00" / "RM 0.00", with the tone: red for a loss, green for a gain, neutral at 0. */
export function signedMoney(value: number, money: (n: number) => string): { text: string; tone: 'loss' | 'gain' | 'zero' } {
  if (value < 0) return { text: `−${money(Math.abs(value))}`, tone: 'loss' }
  if (value > 0) return { text: `+${money(value)}`, tone: 'gain' }
  return { text: money(0), tone: 'zero' }
}

/** "1 bill" / "3 bills" (also for other simple English nouns). */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** The warning when a POS branch's window opened before sales deduction went live (or no start is recorded), else null. The server never flags a branch without POS bills. */
export function partialPeriodNote(s: Pick<StockUsageSummary, 'partial_period' | 'depletion_started_at' | 'has_pos_sales'>): string | null {
  if (!s.partial_period || !s.has_pos_sales) return null
  if (!s.depletion_started_at) return 'Sales deduction has not started at this branch yet'
  return `Sales deduction started ${myt(s.depletion_started_at)} — sales before that are not included, so this period's unexplained figure is overstated.`
}

/** Biggest unexplained loss first, then most sold by value, then by name. */
export function sortUsageRows(rows: StockUsageRow[]): StockUsageRow[] {
  return [...rows].sort((a, b) =>
    a.unexplained_value - b.unexplained_value
    || b.sold_value - a.sold_value
    || a.item_name.localeCompare(b.item_name))
}

export function formatPct(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)}%`
}

function myt(iso: string): string {
  const d = new Date(iso)
  const day = d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short' })
  const time = d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

export function formatPeriod(startIso: string, endIso: string): string {
  return `${myt(startIso)} → ${myt(endIso)}`
}

/** "since 10 Nov 09:05" when an item's window starts at a different moment than the summary's; null otherwise. */
export function sinceLabel(itemStartIso: string, summaryStartIso: string): string | null {
  if (new Date(itemStartIso).getTime() === new Date(summaryStartIso).getTime()) return null
  return `since ${myt(itemStartIso)}`
}
