// src/features/pos/checkout/transactions.ts
/** The Transaction screen's list (spec §5): today's closed bills, filtered and searched. */
import { formatSen } from '../order/cart'
import { partLabel } from '../print/receipt'
import { callNoMatches, takeawayLabel } from '../order/callNo'
import type { ClosedBillRow, PaymentRow } from './checkoutApi'

export type TxFilter = 'all' | 'paid' | 'voided' | 'refunded' | 'merged'
export const TX_FILTERS: { id: TxFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'paid', label: 'Paid' }, { id: 'voided', label: 'Voided' },
  { id: 'refunded', label: 'Refunded' }, { id: 'merged', label: 'Merged' },
]

type TxBill = Pick<ClosedBillRow, 'bill_no' | 'status' | 'refunded_sen' | 'order_type' | 'dining_tables' | 'call_no'>

/** "Table T3", "TA012 · Takeaway" (W4), "Takeaway" (before W4), or "—" for a dine-in bill whose table is gone. */
export function txWhere(b: Pick<ClosedBillRow, 'order_type' | 'dining_tables' | 'call_no'>): string {
  return b.dining_tables ? `Table ${b.dining_tables.label}` : b.order_type === 'takeaway' ? takeawayLabel(b.call_no) : '—'
}

/** A paid bill with any refund counts as Refunded, not Paid. */
export function txKind(b: Pick<ClosedBillRow, 'status' | 'refunded_sen'>): Exclude<TxFilter, 'all'> {
  return b.status === 'paid' ? (b.refunded_sen > 0 ? 'refunded' : 'paid') : b.status
}

/** The filter, then the search on the bill number, the table / Takeaway (any case) or the call number
 *  ("TA12", "ta012" and "12" find TA012). */
export function filterTransactions<T extends TxBill>(bills: T[], filter: TxFilter, search: string): T[] {
  const q = search.trim().toLowerCase()
  return bills.filter((b) => (filter === 'all' || txKind(b) === filter)
    && (!q || b.bill_no.toLowerCase().includes(q) || txWhere(b).toLowerCase().includes(q) || callNoMatches(b.call_no, q)))
}

export function txStatusLabel(b: Pick<ClosedBillRow, 'status' | 'refunded_sen'>): string {
  const k = txKind(b)
  return k === 'refunded' ? `Refunded ${formatSen(b.refunded_sen)}` : k === 'paid' ? 'Paid' : k === 'voided' ? 'Voided' : 'Merged'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "26 Oct 2026": today in Malaysia (UTC+8), whatever the iPad's time zone. */
export function mytDateLabel(nowMs: number): string {
  const d = new Date(nowMs + 8 * 3600_000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** One payment on the bill detail: "Part 2 of 4 · Cash · received RM 50.00, change RM 26.80" for a part
 *  paid on the open bill (split equally / by amount), the method alone for the final payment. */
export function txPaymentLabel(p: Pick<PaymentRow, 'method_name' | 'reference' | 'tendered_sen' | 'change_sen' | 'part'>): string {
  return `${p.part ? `${partLabel(p.part.partNo, p.part.ways)} · ` : ''}${p.method_name}${p.reference ? ` · ${p.reference}` : ''}`
    + (p.tendered_sen !== null ? ` · received ${formatSen(p.tendered_sen)}, change ${formatSen(p.change_sen)}` : '')
}

/** The labels of a bill's payments: on a bill paid in parts, a final payment says "Balance · …". */
export function txPaymentLabels(payments: Pick<PaymentRow, 'method_name' | 'reference' | 'tendered_sen' | 'change_sen' | 'part'>[]): string[] {
  const inParts = payments.some((p) => p.part)
  return payments.map((p) => (inParts && !p.part ? `Balance · ${txPaymentLabel(p)}` : txPaymentLabel(p)))
}

/** A part paid by item is its own bill: it names the table bill it came from. */
export const splitFromNote = (billNo: string): string => `Split from bill ${billNo}.`
