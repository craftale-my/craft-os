// src/features/pos/checkout/partSplit.ts
/** Split equally / by amount (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.5, §4.6):
 *  the Payment screen's part payments. Pure. The server quotes every equal share (pos_part_quote);
 *  the client never divides the bill itself. */
import { formatSen } from '../order/cart'

export type PartMode = 'none' | 'equal' | 'amount'
/** A part already paid on the open bill (pos_checkout_state.parts). */
export interface BillPart { id: string; partNo: number; ways: number | null; amountSen: number; methods: string[] }
/** pos_part_quote's answer. ways / shareSen null for the by-amount view. */
export interface PartQuote {
  totalSen: number; paidSen: number; balanceSen: number; partsPaid: number; sharesPaid: number
  ways: number | null; shareSen: number | null
}
/** pay_bill_part's answer (the fields the screen uses). */
export interface PartResult {
  partId: string; partNo: number; ways: number | null; amountSen: number; paidSen: number; balanceSen: number
  changeSen: number; receiptQueued: boolean
}
/** A part that went through: from pay_bill_part, or found by Check bill (change then unknown). */
export interface PartDone { partNo: number; amountSen: number; changeSen: number | null; paidSen: number }

export const MIN_WAYS = 2
export const MAX_WAYS = 20
export const PERCENT_CHIPS = [25, 33, 50] as const
export const SPLIT_MODE_LABEL = { item: 'By item', equal: 'Equally', amount: 'By amount' } as const
export const BALANCE_DUE = 'Balance due'
export const AMOUNT_OVER_BALANCE = 'The amount is more than the balance'
export const ENTER_AMOUNT = 'Enter the amount'
export const SHARE_LOADING = 'Getting the share — try again in a moment'
export const SHARE_ZERO = 'The share came back as RM 0.00 — check the bill'

export const clampWays = (n: number): number => Math.max(MIN_WAYS, Math.min(MAX_WAYS, Math.trunc(n)))
/** The N of the bill's equal split once a share was paid (it is then fixed); null before. */
export function fixedWays(parts: BillPart[]): number | null {
  const equal = parts.filter((p) => p.ways !== null)
  return equal.length > 0 ? equal[equal.length - 1].ways : null
}
/** By amount with nothing (or nothing above 0) typed: there is no part to pay yet, so Pay is off. */
export const amountMissing = (mode: PartMode, dueSen: number | null): boolean =>
  mode === 'amount' && (dueSen === null || dueSen <= 0)
export const splitIntoLabel = (n: number): string => `Split into ${n}`
export const shareLabel = (k: number, n: number, sen: number): string => `Share ${k} of ${n} · ${formatSen(sen)}`
/** "Paid 1 of 3 · RM 23.45 (Cash)" for an equal share (k counts equal shares only); "Paid part 2 · RM 10.00 (Card)" by amount. */
export function paidPartLabel(part: BillPart, parts: BillPart[]): string {
  const how = part.methods.length > 0 ? ` (${part.methods.join(', ')})` : ''
  if (part.ways !== null) {
    const k = parts.filter((p) => p.ways !== null && p.partNo <= part.partNo).length
    return `Paid ${k} of ${part.ways} · ${formatSen(part.amountSen)}${how}`
  }
  return `Paid part ${part.partNo} · ${formatSen(part.amountSen)}${how}`
}
/** The bill header and the home tile while a bill has parts. */
export const partPaidTag = (sen: number): string => `Part paid · ${formatSen(sen)}`
export function partPaidNote(r: PartDone): string {
  return `Part ${r.partNo} paid · ${formatSen(r.amountSen)}${r.changeSen !== null ? ` · Change ${formatSen(r.changeSen)}` : ''}`
}

/** A percent of the bill total, rounded down to 5 sen and kept below the balance; null when nothing is left to offer. */
export function percentChipSen(totalSen: number, pct: number, balanceSen: number): number | null {
  const want = Math.floor((totalSen * pct) / 100 / 5) * 5
  const cap = Math.floor((balanceSen - 1) / 5) * 5
  const sen = Math.min(want, cap)
  return sen > 0 ? sen : null
}

/** Pay's check of a part before it goes out. An amount equal to the balance is fine: it pays the rest (checkout_bill). */
export function partProblem(mode: PartMode, dueSen: number | null, balanceSen: number): string | null {
  if (mode === 'amount') {
    if (dueSen === null || dueSen <= 0) return ENTER_AMOUNT
    if (dueSen > balanceSen) return AMOUNT_OVER_BALANCE
    return null
  }
  if (mode === 'equal' && dueSen === null) return SHARE_LOADING
  return null
}

/** Equally: what Pay does, decided from the quote itself (never from the screen's balance, which may lag it).
 *  A share below the quote's balance is a part (pay_bill_part); otherwise Pay is the rest: checkout_bill of the
 *  balance (a balance of 0 with no payment). A share of 0 against a balance is a problem: Pay is off. */
export type EqualPay = { kind: 'part'; shareSen: number } | { kind: 'rest' } | { kind: 'problem'; problem: string }
export function equalPay(q: PartQuote | null): EqualPay {
  if (q === null) return { kind: 'problem', problem: SHARE_LOADING }
  if (q.balanceSen === 0) return { kind: 'rest' }
  if (q.shareSen === null || q.shareSen <= 0) return { kind: 'problem', problem: SHARE_ZERO }
  return q.shareSen < q.balanceSen ? { kind: 'part', shareSen: q.shareSen } : { kind: 'rest' }
}

/** The order screen's Payment button: the balance (total less what the parts paid), never below 0. */
export const payLabelFor = (totalSen: number, paidSen: number): string => `Payment ${formatSen(Math.max(0, totalSen - paidSen))}`

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number'
const numOrNull = (x: unknown): x is number | null => x === null || typeof x === 'number'
const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

export function parsePartQuote(d: unknown): PartQuote {
  if (!isObj(d) || !isNum(d.totalSen) || !isNum(d.paidSen) || !isNum(d.balanceSen) || !isNum(d.partsPaid) || !isNum(d.sharesPaid)
      || !numOrNull(d.ways) || !numOrNull(d.shareSen)) return unexpected()
  return { totalSen: d.totalSen, paidSen: d.paidSen, balanceSen: d.balanceSen, partsPaid: d.partsPaid, sharesPaid: d.sharesPaid,
           ways: d.ways, shareSen: d.shareSen }
}

export function parsePartResult(d: unknown): PartResult {
  if (!isObj(d) || typeof d.partId !== 'string' || !isNum(d.partNo) || !numOrNull(d.ways) || !isNum(d.amountSen) || !isNum(d.paidSen)
      || !isNum(d.balanceSen) || !isNum(d.changeSen) || typeof d.receiptQueued !== 'boolean') return unexpected()
  return { partId: d.partId, partNo: d.partNo, ways: d.ways, amountSen: d.amountSen, paidSen: d.paidSen, balanceSen: d.balanceSen,
           changeSen: d.changeSen, receiptQueued: d.receiptQueued }
}

export function parseBillParts(d: unknown): BillPart[] {
  if (!Array.isArray(d)) return unexpected()
  return d.map((p) => {
    if (!isObj(p) || typeof p.id !== 'string' || !isNum(p.partNo) || !numOrNull(p.ways) || !isNum(p.amountSen)
        || !Array.isArray(p.methods) || !p.methods.every((m) => typeof m === 'string')) return unexpected()
    return { id: p.id, partNo: p.partNo, ways: p.ways, amountSen: p.amountSen, methods: p.methods as string[] }
  })
}
