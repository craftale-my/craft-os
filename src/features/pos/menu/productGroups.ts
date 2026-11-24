// src/features/pos/menu/productGroups.ts
/** The Takeaway fees and Print routes pages, pure so they are tested. Neither has a table of its
 *  own: the fee and the route live on each product, so the pages group the products by that value.
 *  Add-on items are left out (they sell only inside an add-on group); switched-off products count. */
import type { MenuProductRow } from './menuApi'
import { cleanName, nameProblem } from './menuForms'
import { NO_FILTER, ringgit, routeText, tableRows } from './productTable'

export interface ProductGroup<V> { value: V; label: string; products: MenuProductRow[] }
/** What a "+ New" box answers: the value to open, or why it cannot be one. */
export type NewValue<V> = { value: V } | { problem: string }

export const feeLabel = (sen: number): string => (sen > 0 ? ringgit(sen) : 'No fee')

/** Every product that is not an add-on item, in menu order, bucketed by `valueOf`; `none`'s group last. */
function groupBy<V>(
  rows: MenuProductRow[], valueOf: (r: MenuProductRow) => V, label: (v: V) => string, none: V, order: (a: V, b: V) => number,
): ProductGroup<V>[] {
  const buckets = new Map<V, MenuProductRow[]>()
  for (const r of tableRows(rows, { ...NO_FILTER, showInactive: true })) {
    const v = valueOf(r)
    const list = buckets.get(v)
    if (list) list.push(r)
    else buckets.set(v, [r])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => Number(a === none) - Number(b === none) || order(a, b))
    .map(([value, products]) => ({ value, label: label(value), products }))
}

/** By takeaway fee: lowest amount first, "No fee" last. */
export function groupByFee(rows: MenuProductRow[]): ProductGroup<number>[] {
  return groupBy(rows, (r) => r.takeaway_fee_sen, feeLabel, 0, (a, b) => a - b)
}

/** By print route: names A–Z, "No ticket" last. */
export function groupByRoute(rows: MenuProductRow[]): ProductGroup<string | null>[] {
  return groupBy(rows, (r) => r.print_route, routeText, null, (a, b) => (a ?? '').localeCompare(b ?? ''))
}

/** The most a packaging fee can be: RM 10.00 (Feedme's highest today is RM 2.12). */
export const MAX_FEE_SEN = 1000

/** A fee box → sen. Digits with at most 2 decimals only ("1", "1.5", "1.50", ".5"): no comma (the iPad's
 *  decimal keypad types "," in some regions, and "1,5" must not become RM 15), no sign, no "RM".
 *  0 is refused unless `allowZero`; above RM 10.00 is refused. Integer arithmetic only.
 *  Not the checkout's parseRinggit, which accepts commas and up to RM 999 999.99. */
export function parseFeeSen(text: string, { allowZero }: { allowZero: boolean }): NewValue<number> {
  const t = text.trim()
  const m = /^(?:(\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/.exec(t)
  if (!m) return { problem: 'Enter the fee in RM, e.g. 1.50' }
  const whole = m[1] ?? '0'
  const frac = (m[2] ?? m[3] ?? '').padEnd(2, '0')
  const sen = whole.length > 4 ? Infinity : Number(whole) * 100 + Number(frac)
  if (sen > MAX_FEE_SEN) return { problem: 'A packaging fee can be at most RM 10.00' }
  if (sen === 0 && !allowZero) return { problem: 'A fee must be more than RM 0.00 — Remove takes a product off its fee' }
  return { value: sen }
}

/** "+ New fee": an amount in RM above zero, at most RM 10.00 ("1.50"). */
export const parseNewFee = (text: string): NewValue<number> => parseFeeSen(text, { allowZero: false })

const RESERVED_ROUTES = ['no ticket', 'null']

/** '+ New route': a name of at most 40 characters. A name already in use (letter case ignored) is
 *  that route, spelled as stored: each branch maps the exact name to a printer in POS settings. */
export function parseNewRoute(text: string, existing: string[]): NewValue<string> {
  const problem = nameProblem('Route', text, 40)
  if (problem) return { problem }
  const name = cleanName(text)
  // "No ticket" is the none group's label and "null" its React key: neither may be a route's name
  if (RESERVED_ROUTES.includes(name.toLowerCase())) return { problem: 'That name is reserved — choose another' }
  return { value: existing.find((r) => r.toLowerCase() === name.toLowerCase()) ?? name }
}
