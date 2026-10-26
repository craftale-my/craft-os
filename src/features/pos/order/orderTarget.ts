// src/features/pos/order/orderTarget.ts
/** What the order screen is open on (spec §2). */
import type { OrderType } from '../offline/orderQueue'
import type { OpenBillRow, TableRow } from './posApi'

/** A table: its open bill when it has one; with none yet, `pax` is what the cashier chose in
 *  Select pax and goes with the first order (no bill exists before that, as today). A takeaway:
 *  an open takeaway bill, or `billId` null for a new takeaway order. */
export type OrderTarget =
  | { kind: 'table'; tableId: string; pax: number | null }
  | { kind: 'takeaway'; billId: string | null }

export const targetOrderType = (t: OrderTarget): OrderType => (t.kind === 'table' ? 'dine_in' : 'takeaway')

/** The open bill the target is on, or null (an empty table, a new takeaway, a bill closed meanwhile). */
export function targetBill(t: OrderTarget, bills: OpenBillRow[]): OpenBillRow | null {
  if (t.kind === 'table') return bills.find((b) => b.table_id === t.tableId) ?? null
  return t.billId ? bills.find((b) => b.id === t.billId) ?? null : null
}

/** pos_insert_order opens a new bill for every takeaway order, so an open takeaway bill takes no
 *  more items: its drafts would land on a second bill. */
export const takesNewItems = (t: OrderTarget): boolean => !(t.kind === 'takeaway' && t.billId !== null)
export const TAKEAWAY_ONE_ORDER = 'A takeaway bill takes one order. For more items, start a new takeaway from the home screen.'

/** The pax to show: the bill's, else what Select pax chose for a table with no bill yet. */
export const shownPax = (t: OrderTarget, bill: OpenBillRow | null): number | null =>
  bill?.pax ?? (t.kind === 'table' ? t.pax : null)

/** "Table T3", "Takeaway 261026-004" or "New takeaway". */
export function billTitle(tableId: string | null, billNo: string | null, tables: Pick<TableRow, 'id' | 'label'>[]): string {
  if (tableId) return `Table ${tables.find((t) => t.id === tableId)?.label ?? '?'}`
  return billNo ? `Takeaway ${billNo}` : 'New takeaway'
}

export const targetTitle = (t: OrderTarget, bill: OpenBillRow | null, tables: Pick<TableRow, 'id' | 'label'>[]): string =>
  billTitle(t.kind === 'table' ? t.tableId : null, bill?.bill_no ?? null, tables)
