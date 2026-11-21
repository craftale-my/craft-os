// Explicit .ts extension: the Node print agent loads this file directly (no bundler).
import { formatMyt, wrap } from './ticket.ts'
import type { FontSize } from './doc.ts'
import type { ReceiptLogo } from './logo.ts'

/** The customer receipt. pos_receipt_payload (supabase/migration-2026-10-24-
 *  pos-checkout-fn.sql) builds exactly this shape into print_jobs.payload, so
 *  keep the two in step. Money is integer sen; rates are basis points. */
export interface ReceiptHeader {
  title: string
  legalName: string | null
  registrationNo: string | null
  sstNo: string | null
  address: string | null
  phone: string | null
  email: string | null
  logo?: ReceiptLogo | null // W4: the outlet's logo, printed by the print agent only; absent on receipts queued before W4
}

export interface ReceiptItem {
  qty: number
  name: string
  unitSen: number
  amountSen: number
  mods: string[]
  discounts?: ReceiptDiscount[] // its catalog and item discounts (absent on receipts queued before discounts)
}

export interface ReceiptDiscount {
  label: string // "Staff Meal 50%", "Discount 10%", "Discount"
  amountSen: number
}

export interface ReceiptCharge {
  rateBp: number
  baseSen: number
  amountSen: number
}

export interface ReceiptPayment {
  name: string
  kind: 'cash' | 'card' | 'duitnow' | 'ewallet' | 'other'
  amountSen: number
  tenderedSen: number | null // cash only: what the customer handed over
  reference: string | null
  part?: number | null // a part payment's part number on the final receipt (split bill §6); null = the final payment
}

export interface ReceiptPayload {
  kind: 'receipt'
  route: string
  reprint: boolean
  callNo?: string | null    // W4: the takeaway call number (TA012), big at the top; null for dine-in, absent before W4
  fontSize?: FontSize       // W4: small = Font B, large = double height; absent before W4 (= normal)
  footerQr?: string | null  // W4: printed as a QR code under the footer; absent before W4
  header: ReceiptHeader
  billNo: string
  splitFrom?: { billNo: string; table: string | null } | null // a paid part of a split bill: its table bill (absent before split bill)
  closedAt: string // ISO, UTC
  cashier: string | null
  tableLabel: string | null // null = takeaway
  pax: number | null
  items: ReceiptItem[]
  itemCount: number
  subtotalSen: number
  billDiscountSen?: number // absent on receipts queued before discounts
  sstGroups: ReceiptCharge[]
  serviceChargeGroups: ReceiptCharge[]
  takeawayFeeSen: number
  roundingSen: number
  totalSen: number
  payments: ReceiptPayment[]
  changeSen: number
  footer: string
}

/** A short slip printed on the receipt printer when a paid bill is refunded. */
export interface RefundSlipPayload {
  kind: 'refund'
  route: string
  title: string
  billNo: string
  refundedAt: string // ISO, UTC
  amountSen: number
  methodName: string
  reason: string | null
  refundedBy: string | null
  approvedBy: string | null
}

/** A part paid on an open bill (split bill §4.6, §6): the bill as on a pre-bill (current items and
 *  totals), then this part. Not an official receipt. pos_part_receipt_payload builds exactly this. */
export interface PartReceiptPayload extends Omit<ReceiptPayload, 'kind' | 'splitFrom'> {
  kind: 'part'
  partNo: number
  ways: number | null       // an equal split's N; null = by amount
  amountSen: number         // this part
  paidBeforeSen: number     // the parts before this one
  balanceSen: number        // what is left after this part
}

/** "Part 2 of 3"; "Part 2" for a part by amount. */
export const partLabel = (partNo: number, ways: number | null): string => (ways ? `Part ${partNo} of ${ways}` : `Part ${partNo}`)

const ASCII_MAP: Record<string, string> = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '-', '·': '-', ' ': ' ',
}

/** The ZY301 prints anything outside printable ASCII as "?"; map the common
 *  look-alikes first so "Craft Cafe – Cheras" prints as "Craft Cafe - Cheras". */
export function toAscii(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    out += code >= 0x20 && code < 0x7f ? ch : (ASCII_MAP[ch] ?? '?')
  }
  return out
}

export function asciiDeep<T>(value: T): T {
  if (typeof value === 'string') return toAscii(value) as T
  if (Array.isArray(value)) return value.map(asciiDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asciiDeep(v)])) as T
  }
  return value
}

/** 9280 → "92.80", −2 → "-0.02". */
export function money(sen: number): string {
  return `${sen < 0 ? '-' : ''}${(Math.abs(sen) / 100).toFixed(2)}`
}

/** "Split from 261116-009 · T5" (split bill §6); a takeaway table bill has no table. */
export function splitFromLine(s: { billNo: string; table: string | null }): string {
  return s.table ? `Split from ${s.billNo} · ${s.table}` : `Split from ${s.billNo}`
}

function pct(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}

/** Label on the left, value flush right; a label too long for one line wraps and the value goes under it. */
export function lr(left: string, right: string, cols: number): string[] {
  if (left.length + 1 + right.length <= cols) return [left + ' '.repeat(cols - left.length - right.length) + right]
  return [...wrap(left, cols), right.padStart(cols)]
}

export function center(text: string, cols: number): string[] {
  return wrap(text, cols).map((l) => ' '.repeat(Math.max(0, Math.floor((cols - l.length) / 2))) + l)
}

/** "1 Chicken Chop (24.00/ea)" … "24.00": the amount sits on the item's first line. */
function itemLines(it: ReceiptItem, cols: number): string[] {
  const amount = money(it.amountSen)
  const width = cols - amount.length - 1
  const parts = wrap(`${it.qty} ${it.name} (${money(it.unitSen)}/ea)`, width, '   ')
  return [
    `${parts[0].padEnd(width)} ${amount}`,
    ...parts.slice(1),
    ...it.mods.flatMap((m) => wrap(`+ ${m}`, cols - 3, '  ').map((s) => `   ${s}`)),
    ...(it.discounts ?? []).flatMap((d) => lr(`   ${d.label}`, money(-d.amountSen), cols)),
  ]
}

function chargeRow(label: string, base: string, amount: string, cols: number): string {
  const w = cols - 22
  return label.slice(0, w).padEnd(w) + base.padStart(11) + amount.padStart(11)
}

type HeadInput = Pick<ReceiptPayload, 'reprint' | 'header' | 'billNo' | 'closedAt' | 'cashier' | 'pax' | 'tableLabel' | 'splitFrom'>
type BodyInput = Pick<ReceiptPayload, 'items' | 'itemCount' | 'subtotalSen' | 'billDiscountSen' | 'sstGroups' | 'serviceChargeGroups'
  | 'takeawayFeeSen' | 'roundingSen' | 'totalSen'>

/** Title, outlet details, invoice no (and Split from), date, cashier, pax, table. `r` is ASCII already. */
function headLines(r: HeadInput, cols: number): string[] {
  const h = r.header
  return [
    ...(r.reprint ? center('*** REPRINT ***', cols) : []),
    ...center(h.title, cols),
    ...(h.legalName ? center(h.legalName, cols) : []),
    ...(h.registrationNo ? center(`REG NO: ${h.registrationNo}`, cols) : []),
    ...(h.sstNo ? center(`SST NO: ${h.sstNo}`, cols) : []),
    ...(h.address ? center(h.address, cols) : []),
    ...(h.phone ? center(`TEL: ${h.phone}`, cols) : []),
    ...(h.email ? center(h.email, cols) : []),
    '',
    ...lr('Invoice no', r.billNo, cols),
    ...(r.splitFrom ? wrap(toAscii(splitFromLine(r.splitFrom)), cols) : []),   // the · added here is not ASCII yet
    ...lr('Date', formatMyt(r.closedAt), cols),
    ...lr('Cashier', r.cashier ?? '-', cols),
    ...(r.pax !== null ? lr('Table pax', String(r.pax), cols) : []),
    ...center(r.tableLabel ? `ORDER ${r.tableLabel}` : 'TAKEAWAY', cols),
  ]
}

/** The items, the totals and the Total (MYR) band. */
function bodyLines(r: BodyInput, cols: number): string[] {
  const rule = '-'.repeat(cols)
  return [
    rule,
    ...r.items.flatMap((it) => itemLines(it, cols)),
    rule,
    ...lr('Item count', String(r.itemCount), cols),
    ...lr('Subtotal', money(r.subtotalSen), cols),
    ...((r.billDiscountSen ?? 0) > 0 ? lr('Discount', money(-(r.billDiscountSen ?? 0)), cols) : []),
    ...r.sstGroups.flatMap((g) => lr(`SST (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...r.serviceChargeGroups.flatMap((g) => lr(`SERVICE CHARGE (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...(r.takeawayFeeSen > 0 ? lr('Takeaway packaging', money(r.takeawayFeeSen), cols) : []),
    ...lr('Bill rounding', money(r.roundingSen), cols),
    '='.repeat(cols),
    ...lr('Total (MYR)', money(r.totalSen), cols),
    '='.repeat(cols),
  ]
}

/** Each payment (a part's labelled "Part 1 - Cash"; cash shows what was handed over), then Change. */
function paymentLines(payments: ReceiptPayment[], changeSen: number, cols: number): string[] {
  return [
    ...payments.flatMap((p) => [
      ...lr(p.part ? toAscii(`Part ${p.part} · ${p.name}`) : p.name, money(p.kind === 'cash' ? (p.tenderedSen ?? p.amountSen) : p.amountSen), cols),
      ...(p.reference ? wrap(`Ref: ${p.reference}`, cols - 2).map((s) => `  ${s}`) : []),
    ]),
    ...lr('Change', money(changeSen), cols),
  ]
}

export function renderReceiptLines(input: ReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  const rule = '-'.repeat(cols)
  const charges = r.sstGroups.length + r.serviceChargeGroups.length > 0
    ? [
        'Charges summary',
        chargeRow('', 'Base Amt', 'Amount', cols),
        ...r.sstGroups.map((g) => chargeRow(`SST ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        ...r.serviceChargeGroups.map((g) => chargeRow(`SERVICE CHARGE ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        rule,
      ]
    : []
  return [
    ...headLines(r, cols),
    ...bodyLines(r, cols),
    ...paymentLines(r.payments, r.changeSen, cols),
    rule,
    ...charges,
    ...center(r.footer, cols),
  ].map((l) => l.trimEnd())
}

/** A part receipt: the bill, then "Part 2 of 3", this part's payments and change, Paid before and Balance due. */
export function renderPartReceiptLines(input: PartReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  return [
    ...headLines(r, cols),
    ...bodyLines(r, cols),
    ...center(partLabel(r.partNo, r.ways), cols),
    ...lr('This part (MYR)', money(r.amountSen), cols),
    ...paymentLines(r.payments, r.changeSen, cols),
    ...lr('Paid before', money(r.paidBeforeSen), cols),
    ...lr('Balance due', money(r.balanceSen), cols),
    '-'.repeat(cols),
    ...center(r.footer, cols),
  ].map((l) => l.trimEnd())
}

export function renderRefundSlipLines(input: RefundSlipPayload, cols: number): string[] {
  const s = asciiDeep(input)
  const rule = '-'.repeat(cols)
  return [
    ...center(s.title, cols),
    ...center('REFUND', cols),
    '',
    ...lr('Invoice no', s.billNo, cols),
    ...lr('Date', formatMyt(s.refundedAt), cols),
    ...lr('Refunded by', s.refundedBy ?? '-', cols),
    ...lr('Approved by', s.approvedBy ?? '-', cols),
    rule,
    ...lr('Refund (MYR)', money(s.amountSen), cols),
    ...lr('Paid back by', s.methodName, cols),
    ...(s.reason ? wrap(`Reason: ${s.reason}`, cols, '  ') : []),
    rule,
  ].map((l) => l.trimEnd())
}
