// Explicit .ts extension: the Node print agent loads this file directly (no bundler).
import { formatMyt, wrap } from './ticket.ts'

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
}

export interface ReceiptItem {
  qty: number
  name: string
  unitSen: number
  amountSen: number
  mods: string[]
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
}

export interface ReceiptPayload {
  kind: 'receipt'
  route: string
  reprint: boolean
  header: ReceiptHeader
  billNo: string
  closedAt: string // ISO, UTC
  cashier: string | null
  tableLabel: string | null // null = takeaway
  pax: number | null
  items: ReceiptItem[]
  itemCount: number
  subtotalSen: number
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

const ASCII_MAP: Record<string, string> = {
  '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '-', ' ': ' ',
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
  ]
}

function chargeRow(label: string, base: string, amount: string, cols: number): string {
  const w = cols - 22
  return label.slice(0, w).padEnd(w) + base.padStart(11) + amount.padStart(11)
}

export function renderReceiptLines(input: ReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  const rule = '-'.repeat(cols)
  const h = r.header
  const header = [
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
    ...lr('Date', formatMyt(r.closedAt), cols),
    ...lr('Cashier', r.cashier ?? '-', cols),
    ...(r.pax !== null ? lr('Table pax', String(r.pax), cols) : []),
    ...center(r.tableLabel ? `ORDER ${r.tableLabel}` : 'TAKEAWAY', cols),
  ]
  const totals = [
    ...lr('Item count', String(r.itemCount), cols),
    ...lr('Subtotal', money(r.subtotalSen), cols),
    ...r.sstGroups.flatMap((g) => lr(`SST (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...r.serviceChargeGroups.flatMap((g) => lr(`SERVICE CHARGE (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...(r.takeawayFeeSen > 0 ? lr('Takeaway packaging', money(r.takeawayFeeSen), cols) : []),
    ...lr('Bill rounding', money(r.roundingSen), cols),
  ]
  const payments = [
    ...r.payments.flatMap((p) => [
      ...lr(p.name, money(p.kind === 'cash' ? (p.tenderedSen ?? p.amountSen) : p.amountSen), cols),
      ...(p.reference ? wrap(`Ref: ${p.reference}`, cols - 2).map((s) => `  ${s}`) : []),
    ]),
    ...lr('Change', money(r.changeSen), cols),
  ]
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
    ...header,
    rule,
    ...r.items.flatMap((it) => itemLines(it, cols)),
    rule,
    ...totals,
    '='.repeat(cols),
    ...lr('Total (MYR)', money(r.totalSen), cols),
    '='.repeat(cols),
    ...payments,
    rule,
    ...charges,
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
