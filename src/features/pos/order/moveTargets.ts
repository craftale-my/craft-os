// src/features/pos/order/moveTargets.ts
/** The Move to grid (spec §3): every other active table with what tapping it does. */
import type { BillSummary } from './billSummaries'
import { billTitle } from './orderTarget'
import type { OpenBillRow, TableRow } from './posApi'

/** `tableId` is null only for a takeaway bill offered as a merge target (takeaway into takeaway). */
export type MoveTarget =
  | { tableId: string; label: string; kind: 'move' }
  | { tableId: string | null; label: string; kind: 'merge'; intoBillId: string; intoBillNo: string; totalSen: number | null }
  | { tableId: string | null; label: string; kind: 'refused'; reason: string }

export const TAKEAWAY_NEEDS_OCCUPIED = 'A takeaway bill can only be merged into a table with a bill'
/** The server's words (merge_bills) for a source bill that carries a bill discount. */
export const MERGE_NEEDS_NO_BILL_DISCOUNT = 'Remove the bill discount before merging'

/** An empty table takes a table's bill (move_bill). An occupied table merges this bill into its
 *  bill (merge_bills from this bill into that one). A takeaway bill cannot sit on an empty table,
 *  only merge into an occupied one, or into another open takeaway bill (listed after the tables).
 *  A table bill is never offered a takeaway target, and the bill's own table / own bill is not
 *  listed. With a bill discount on the source, every merge target is `refused` (moving to an empty table stays allowed). `totalSen` is the target bill's total from pos_open_bill_summaries. */
export function moveTargets(
  from: Pick<OpenBillRow, 'id' | 'table_id' | 'order_type'>,
  tables: TableRow[], bills: OpenBillRow[], summaries: ReadonlyMap<string, BillSummary>,
  /** the source bill has a bill discount: merge_bills refuses it, so merge targets are shown refused */
  hasBillDiscount = false,
): MoveTarget[] {
  const byTable = new Map(bills.flatMap((b) => (b.table_id ? [[b.table_id, b] as const] : [])))
  const toTables = tables.filter((t) => t.id !== from.table_id).map((t): MoveTarget => {
    const there = byTable.get(t.id)
    if (there) {
      if (hasBillDiscount) return { tableId: t.id, label: t.label, kind: 'refused', reason: MERGE_NEEDS_NO_BILL_DISCOUNT }
      return { tableId: t.id, label: t.label, kind: 'merge', intoBillId: there.id, intoBillNo: there.bill_no, totalSen: summaries.get(there.id)?.totalSen ?? null }
    }
    if (from.order_type === 'takeaway') return { tableId: t.id, label: t.label, kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED }
    return { tableId: t.id, label: t.label, kind: 'move' }
  })
  if (from.order_type !== 'takeaway') return toTables
  const toTakeaways = bills
    .filter((b) => b.table_id === null && b.id !== from.id)
    .map((b): MoveTarget => hasBillDiscount
      ? { tableId: null, label: billTitle(null, b.bill_no, tables), kind: 'refused', reason: MERGE_NEEDS_NO_BILL_DISCOUNT }
      : {
        tableId: null, label: billTitle(null, b.bill_no, tables), kind: 'merge',
        intoBillId: b.id, intoBillNo: b.bill_no, totalSen: summaries.get(b.id)?.totalSen ?? null,
      })
  return [...toTables, ...toTakeaways]
}
