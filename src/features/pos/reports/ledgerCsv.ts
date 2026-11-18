// The ledger export (spec §5.12): three CSV files for the accountant and the future Accounting module.
// Outlet first in every file (bill numbers are unique per outlet only); money in ringgit, times in
// Malaysia time, SST rate in percent.
import { columnsFor, tableCsv } from './columns'
import { ORDER_TYPE_LABELS } from './reportView'
import type { LedgerBill, LedgerLine, LedgerPayment } from './reportsApi'

const b = columnsFor<LedgerBill>()
const BILL_COLUMNS = [
  b.text('Outlet', (r) => r.outlet), b.day('Business date', (r) => r.businessDate), b.time('Closed at', (r) => r.closedAt),
  b.text('Bill no', (r) => r.billNo), b.text('Order type', (r) => ORDER_TYPE_LABELS[r.orderType] ?? r.orderType),
  b.text('Table', (r) => r.table), b.count('Pax', (r) => r.pax), b.money('Gross', (r) => r.grossSen),
  b.money('Discounts', (r) => r.discountSen), b.money('Takeaway fee', (r) => r.takeawayFeeSen),
  b.money('Service charge', (r) => r.serviceChargeSen), b.money('SST', (r) => r.sstSen), b.money('Rounding', (r) => r.roundingSen),
  b.money('Total', (r) => r.totalSen), b.money('Refunded', (r) => r.refundedSen),
]

const l = columnsFor<LedgerLine>()
const LINE_COLUMNS = [
  l.text('Outlet', (r) => r.outlet), l.text('Bill no', (r) => r.billNo), l.text('Item', (r) => r.item), l.count('Qty', (r) => r.qty),
  l.money('Unit price', (r) => r.unitPriceSen), l.money('Catalog discount', (r) => r.catalogDiscountSen),
  l.money('Item discount', (r) => r.itemDiscountSen), l.money('Bill discount share', (r) => r.billShareSen),
  l.money('Net', (r) => r.netSen), l.count('SST rate (%)', (r) => r.sstRateBp / 100), l.money('SST', (r) => r.sstSen),
]

const p = columnsFor<LedgerPayment>()
const PAYMENT_COLUMNS = [
  p.text('Outlet', (r) => r.outlet), p.text('Bill no', (r) => r.billNo), p.count('Part no', (r) => r.partNo),
  p.text('Method', (r) => r.method), p.text('Kind', (r) => r.kind), p.money('Amount', (r) => r.amountSen),
  p.money('Tendered', (r) => r.tenderedSen), p.money('Change', (r) => r.changeSen), p.text('Reference', (r) => r.reference),
  p.time('Taken at', (r) => r.takenAt),
]

export const billsCsv = (rows: LedgerBill[]): string => tableCsv(BILL_COLUMNS, rows)
export const linesCsv = (rows: LedgerLine[]): string => tableCsv(LINE_COLUMNS, rows)
export const paymentsCsv = (rows: LedgerPayment[]): string => tableCsv(PAYMENT_COLUMNS, rows)
