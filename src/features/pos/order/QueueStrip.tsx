// src/features/pos/order/QueueStrip.tsx
import type { FlushReport, QueuedOrder } from '../offline/orderQueue'
import type { BranchCatalogs } from './catalogs'
import type { TableRow } from './posApi'

/** The offline queue strip, moved from the old PosPage header unchanged (spec §1 banners): orders
 *  waiting to send with Retry now, and every rejected order with Edit (back to the order screen,
 *  cart intact) and Discard. Renders nothing when the queue is clear. */
export default function QueueStrip({ report, stuck, discardError, tables, catalogs, productNames, onRetry, onEdit, onDiscard }: {
  report: FlushReport | null
  stuck: QueuedOrder[]
  discardError: string | null
  tables: TableRow[]
  catalogs: BranchCatalogs | null
  productNames: Map<string, string> | null
  onRetry: () => void
  onEdit: (o: QueuedOrder) => void
  onDiscard: (clientOrderId: string) => void
}) {
  const waiting = report && (report.pending > 0 || report.lastError)
  if (!waiting && stuck.length === 0 && !discardError) return null
  return (
    <div className="space-y-1 border-b border-border bg-amber-50 px-4 py-2 text-sm">
      {waiting && (
        <p className="text-amber-800">
          {report.pending} order{report.pending === 1 ? '' : 's'} waiting to send{report.lastError ? ` — ${report.lastError}` : ''}{' '}
          <button type="button" className="min-h-11 px-2 underline" onClick={onRetry}>Retry now</button>
        </p>
      )}
      {stuck.map((o) => {
        const n = o.items.reduce((sum, l) => sum + l.qty, 0)
        const where = o.tableId ? `Table ${tables.find((t) => t.id === o.tableId)?.label ?? '?'}` : 'Takeaway'
        const catalog = o.catalogId ? catalogs?.catalogs.find((c) => c.id === o.catalogId)?.name : null
        const names = o.items.map((l) => `${l.qty} × ${productNames?.get(l.productId) || 'Unknown item'}`).join(', ')
        return (
          <p key={o.clientOrderId} className="text-red-700">
            Rejected: {o.failedReason} · {where}{catalog ? ` · ${catalog}` : ''} · {n} item{n === 1 ? '' : 's'} ({names}){' '}
            <button type="button" className="mr-2 min-h-11 px-2 underline" onClick={() => onEdit(o)}>Edit</button>
            <button type="button" className="min-h-11 px-2 underline" onClick={() => onDiscard(o.clientOrderId)}>Discard</button>
          </p>
        )
      })}
      {discardError && <p className="text-red-700">Could not discard: {discardError}</p>}
    </div>
  )
}
