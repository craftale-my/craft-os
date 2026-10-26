// src/features/pos/checkout/transactions.ts
/** The Transaction screen's list (spec §5): today's closed bills, filtered and searched. */
import { formatSen } from '../order/cart'
import type { ClosedBillRow } from './checkoutApi'

export type TxFilter = 'all' | 'paid' | 'voided' | 'refunded' | 'merged'
export const TX_FILTERS: { id: TxFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'paid', label: 'Paid' }, { id: 'voided', label: 'Voided' },
  { id: 'refunded', label: 'Refunded' }, { id: 'merged', label: 'Merged' },
]

type TxBill = Pick<ClosedBillRow, 'bill_no' | 'status' | 'refunded_sen' | 'order_type' | 'dining_tables'>

/** "Table T3", "Takeaway", or "—" for a dine-in bill whose table is gone. */
export function txWhere(b: Pick<ClosedBillRow, 'order_type' | 'dining_tables'>): string {
  return b.dining_tables ? `Table ${b.dining_tables.label}` : b.order_type === 'takeaway' ? 'Takeaway' : '—'
}

/** A paid bill with any refund counts as Refunded, not Paid. */
export function txKind(b: Pick<ClosedBillRow, 'status' | 'refunded_sen'>): Exclude<TxFilter, 'all'> {
  return b.status === 'paid' ? (b.refunded_sen > 0 ? 'refunded' : 'paid') : b.status
}

/** The filter, then the search on the bill number or the table / Takeaway (any case). */
export function filterTransactions<T extends TxBill>(bills: T[], filter: TxFilter, search: string): T[] {
  const q = search.trim().toLowerCase()
  return bills.filter((b) => (filter === 'all' || txKind(b) === filter)
    && (!q || b.bill_no.toLowerCase().includes(q) || txWhere(b).toLowerCase().includes(q)))
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
