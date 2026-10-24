// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { formatMyt, wrap } from './ticket.ts'
import { asciiDeep, center, lr, money } from './receipt.ts'

/** The Z report of one shift (Feedme's "Close up" without discount, delivery and
 *  member sections). pos_shift_report (supabase/migration-2026-10-24-pos-shifts-fn.sql)
 *  builds exactly this shape once, at close; it is frozen in pos_shifts.report.
 *  Money is integer sen; times are ISO, UTC. */
export interface ZReportPayment {
  name: string
  kind: string
  count: number
  amountSen: number
  refundCount: number
  refundSen: number
  netSen: number
}

export interface ZReportCashMove {
  kind: 'pay_in' | 'pay_out'
  amountSen: number
  reason: string
  by: string | null
  approvedBy: string | null // pay out only
  at: string
}

export interface ZReportVoidItem {
  at: string
  billNo: string
  name: string
  qty: number
  valueSen: number
  reason: string | null
  by: string | null
  approvedBy: string | null
}

export interface ZReportVoidBill {
  at: string
  billNo: string
  reason: string | null
  by: string | null
  approvedBy: string | null
}

export interface ZReportRefund {
  at: string
  billNo: string
  amountSen: number
  method: string
  reason: string | null
  approvedBy: string | null
}

export interface ZReport {
  branch: string
  openedAt: string
  openedBy: string | null
  closedAt: string
  closedBy: string | null
  summary: {
    billCount: number
    pax: number
    nettSen: number
    avgPerBillSen: number
    avgPerPaxSen: number
    voidBillCount: number
    voidSen: number
    refundSen: number
  }
  sales: { grossSen: number; takeawayFeeSen: number; serviceChargeSen: number; sstSen: number; roundingSen: number; nettSen: number }
  payments: ZReportPayment[]
  orderTypes: { orderType: 'dine_in' | 'takeaway'; bills: number; nettSen: number }[]
  sources: { source: 'counter' | 'qr'; orders: number; itemSen: number }[]
  cash: {
    openingFloatSen: number
    cashSalesSen: number
    cashRefundSen: number
    moves: ZReportCashMove[]
    payInSen: number
    payOutSen: number
    expectedSen: number
    firstCountSen: number | null
    countedSen: number | null
    varianceSen: number | null
    varianceReason: string | null
    varianceApprovedBy: string | null
  }
  voids: { items: ZReportVoidItem[]; bills: ZReportVoidBill[] }
  refunds: ZReportRefund[]
  products: { name: string; qty: number; valueSen: number }[]
}

/** print_jobs.payload of a Z report (print_jobs.kind stays 'receipt'). */
export interface ZReportPayload {
  kind: 'zreport'
  route: string
  reprint: boolean
  report: ZReport
}

const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway' }
const SOURCE_LABEL: Record<string, string> = { counter: 'Counter', qr: 'QR' }

/** −615 → "-6.15", 50 → "+0.50", 0 → "0.00". */
export function signedMoney(sen: number): string {
  return sen > 0 ? `+${money(sen)}` : money(sen)
}

const indented = (text: string, cols: number) => wrap(text, cols - 2, '  ').map((s) => `  ${s}`)

export function renderZReportLines(input: ZReportPayload, cols: number): string[] {
  const r = asciiDeep(input.report)
  const rule = '-'.repeat(cols)
  const s = r.summary
  const c = r.cash
  const section = (title: string, lines: string[]) => [rule, title, ...lines]
  return [
    ...(input.reprint ? center('*** REPRINT ***', cols) : []),
    ...center(r.branch, cols),
    ...center('CLOSE UP REPORT', cols),
    '',
    ...lr('Opened', formatMyt(r.openedAt), cols),
    ...lr('Opened by', r.openedBy ?? '-', cols),
    ...lr('Closed', formatMyt(r.closedAt), cols),
    ...lr('Closed by', r.closedBy ?? '-', cols),
    ...section('SUMMARY', [
      ...lr('Bills', String(s.billCount), cols),
      ...lr('Pax', String(s.pax), cols),
      ...lr('Nett sales', money(s.nettSen), cols),
      ...lr('Average per bill', money(s.avgPerBillSen), cols),
      ...lr('Average per pax', money(s.avgPerPaxSen), cols),
      ...lr('Void bills', String(s.voidBillCount), cols),
      ...lr('Total void', money(s.voidSen), cols),
      ...lr('Total refund', money(s.refundSen), cols),
    ]),
    ...section('SALES SUMMARY', [
      ...lr('Gross sales', money(r.sales.grossSen), cols),
      ...lr('Takeaway fee', money(r.sales.takeawayFeeSen), cols),
      ...lr('Service charge', money(r.sales.serviceChargeSen), cols),
      ...lr('SST', money(r.sales.sstSen), cols),
      ...lr('Rounding', money(r.sales.roundingSen), cols),
      ...lr('Nett sales', money(r.sales.nettSen), cols),
    ]),
    ...section('PAYMENTS', r.payments.length === 0 ? ['No payments'] : r.payments.flatMap((p) => [
      ...lr(`${p.name} (${p.count})`, money(p.amountSen), cols),
      ...(p.refundCount > 0 ? lr(`  Refunds (${p.refundCount})`, money(-p.refundSen), cols) : []),
      ...lr('  Net', money(p.netSen), cols),
    ])),
    ...section('ORDER TYPE', r.orderTypes.flatMap((o) => lr(`${ORDER_TYPE_LABEL[o.orderType] ?? o.orderType} (${o.bills})`, money(o.nettSen), cols))),
    ...section('SOURCE', r.sources.flatMap((o) => lr(`${SOURCE_LABEL[o.source] ?? o.source} (${o.orders} order${o.orders === 1 ? '' : 's'})`, money(o.itemSen), cols))),
    ...section('CASH DRAWER', [
      ...lr('Opening float', money(c.openingFloatSen), cols),
      ...lr('Cash sales', money(c.cashSalesSen), cols),
      ...lr('Cash refunds', money(-c.cashRefundSen), cols),
      ...c.moves.flatMap((m) => [
        ...lr(`${m.kind === 'pay_in' ? 'Pay in' : 'Pay out'}: ${m.reason}`, money(m.kind === 'pay_in' ? m.amountSen : -m.amountSen), cols),
        ...indented(`by ${m.by ?? '-'}${m.approvedBy ? `, approved by ${m.approvedBy}` : ''}`, cols),
      ]),
      ...lr('Expected cash', money(c.expectedSen), cols),
      ...(c.firstCountSen !== null && c.firstCountSen !== c.countedSen ? lr('First count', money(c.firstCountSen), cols) : []),
      ...lr('Counted cash', c.countedSen === null ? '-' : money(c.countedSen), cols),
      ...lr('Variance', c.varianceSen === null ? '-' : signedMoney(c.varianceSen), cols),
      ...(c.varianceReason ? indented(`Reason: ${c.varianceReason}`, cols) : []),
      ...(c.varianceApprovedBy ? indented(`Approved by ${c.varianceApprovedBy}`, cols) : []),
    ]),
    ...section('VOIDS', r.voids.items.length + r.voids.bills.length === 0 ? ['No voids'] : [
      ...r.voids.items.flatMap((v) => [
        ...lr(`${v.qty} ${v.name}`, money(v.valueSen), cols),
        ...indented(`${v.billNo}, ${v.reason ?? '-'}, by ${v.by ?? '-'}${v.approvedBy ? `, approved by ${v.approvedBy}` : ''}`, cols),
      ]),
      ...r.voids.bills.flatMap((v) => wrap(
        `Bill ${v.billNo} voided, ${v.reason ?? '-'}, by ${v.by ?? '-'}${v.approvedBy ? `, approved by ${v.approvedBy}` : ''}`, cols, '  ')),
    ]),
    ...section('REFUNDS', r.refunds.length === 0 ? ['No refunds'] : r.refunds.flatMap((f) => [
      ...lr(`${f.billNo} ${f.method}`, money(f.amountSen), cols),
      ...indented(`${f.reason ?? '-'}${f.approvedBy ? `, approved by ${f.approvedBy}` : ''}`, cols),
    ])),
    ...section('PRODUCT SALES', r.products.length === 0 ? ['No sales'] : r.products.flatMap((p) => lr(`${p.qty} ${p.name}`, money(p.valueSen), cols))),
    rule,
    ...center('END OF REPORT', cols),
  ].map((l) => l.trimEnd())
}
