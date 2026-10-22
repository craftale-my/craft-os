import type { OpenBillRow, TableRow } from './posApi'

export type TableState = 'empty' | 'open' | 'new'
export interface TableCard { id: string; label: string; state: TableState; paused: boolean; bill: OpenBillRow | null }

/** One card per active table. `newBillIds` = bills that received a QR order the
 *  cashier has not opened yet (PosPage marks them from Realtime inserts). */
export function tableCards(tables: TableRow[], bills: OpenBillRow[], newBillIds: ReadonlySet<string>): TableCard[] {
  const byTable = new Map(bills.filter((b) => b.table_id).map((b) => [b.table_id as string, b]))
  return tables.map((t) => {
    const bill = byTable.get(t.id) ?? null
    return { id: t.id, label: t.label, paused: t.qr_paused, bill, state: !bill ? 'empty' : newBillIds.has(bill.id) ? 'new' : 'open' }
  })
}

export function takeawayBills(bills: OpenBillRow[]): OpenBillRow[] {
  return bills.filter((b) => b.table_id === null)
}
