// src/features/pos/order/billSummaries.ts
/** pos_open_bill_summaries (supabase/migration-2026-10-26-pos-frontend.sql): every open bill of
 *  the branch with the total checkout would charge (pos_bill_totals) its live item count and what its parts paid (paid_sen, split spec §4.6).
 *  The home tiles and the Move to grid show these, never a total of their own. */
export interface BillSummary { billId: string; totalSen: number; itemCount: number; paidSen?: number }

const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

/** Keyed by bill id. Throws "Unexpected reply from the server" for anything else. */
export function parseBillSummaries(data: unknown): Map<string, BillSummary> {
  if (!Array.isArray(data)) return unexpected()
  const out = new Map<string, BillSummary>()
  for (const row of data) {
    if (typeof row !== 'object' || row === null) return unexpected()
    const { bill_id, total_sen, item_count, paid_sen } = row as Record<string, unknown>
    if (typeof bill_id !== 'string' || typeof total_sen !== 'number' || typeof item_count !== 'number'
        || (paid_sen !== undefined && typeof paid_sen !== 'number')) return unexpected()
    out.set(bill_id, { billId: bill_id, totalSen: total_sen, itemCount: item_count, paidSen: typeof paid_sen === 'number' ? paid_sen : 0 })
  }
  return out
}
