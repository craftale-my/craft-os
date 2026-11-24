/** Split tender on the checkout sheet. The server repeats every one of these
 *  checks (checkout_bill) with the same words; this is only so the cashier
 *  sees the problem before pressing Pay. */

export type PaymentKind = 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'

export interface TenderMethod {
  id: string
  name: string
  kind: PaymentKind
  needsReference: boolean
}

export interface TenderLine {
  key: string
  method: TenderMethod
  amountSen: number
  tenderedSen: number | null // cash only; null = exact
  reference: string | null
}

/** "12.5" / "RM 12.50" / "12" → sen; null when it is not a sensible amount. */
export function parseRinggit(text: string): number | null {
  const t = text.replace(/rm/i, '').replace(/,/g, '').trim()
  if (!/^\d{1,6}(\.\d{0,2})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

export function paidSen(lines: TenderLine[]): number {
  return lines.reduce((n, l) => n + l.amountSen, 0)
}

export function remainingSen(totalSen: number, lines: TenderLine[]): number {
  return totalSen - paidSen(lines)
}

export function changeSen(lines: TenderLine[]): number {
  return lines.reduce((n, l) => n + (l.method.kind === 'cash' && l.tenderedSen !== null ? l.tenderedSen - l.amountSen : 0), 0)
}

/** Exact, then the notes 10 / 20 / 50 / 100 that cover what is due. */
export function quickTenders(dueSen: number): number[] {
  return [1000, 2000, 5000, 10000].filter((n) => n > dueSen)
}

/** Why this payment line cannot be added, or null. Same words as checkout_bill. */
export function lineProblem(line: Omit<TenderLine, 'key'>, remaining: number): string | null {
  if (!Number.isInteger(line.amountSen) || line.amountSen <= 0) return 'Invalid payment amount'
  if (line.amountSen > remaining) return 'That is more than what is left to pay'
  if (line.tenderedSen !== null) {
    if (line.method.kind !== 'cash') return 'Only cash can be tendered above the amount'
    if (line.tenderedSen < line.amountSen) return 'Cash received is less than the amount'
  }
  if (line.method.needsReference && !line.reference?.trim()) return `Enter the reference for ${line.method.name}`
  return null
}

/** Why Pay is not possible yet, or null. */
export function payProblem(totalSen: number, lines: TenderLine[]): string | null {
  const left = remainingSen(totalSen, lines)
  if (left > 0) return `RM ${(left / 100).toFixed(2)} left to pay`
  if (left < 0) return 'Payments are more than the total'
  return null
}

/** What checkout_bill receives. */
export function toPayments(lines: TenderLine[]): { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }[] {
  return lines.map((l) => ({
    methodId: l.method.id,
    amountSen: l.amountSen,
    tenderedSen: l.method.kind === 'cash' ? l.tenderedSen : null,
    reference: l.reference?.trim() || null,
  }))
}
