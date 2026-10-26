// src/features/pos/order/MoveToGrid.tsx
import { formatSen } from './cart'
import type { MoveTarget } from './moveTargets'

/** Move to (spec §3): every other table with its current total, Feedme style. An empty table moves
 *  the bill there, an occupied one merges it in (OrderScreen asks first), a refused one says why. */
export default function MoveToGrid({ billNo, targets, busy, onPick, onClose }: {
  billNo: string
  targets: MoveTarget[]         // moveTargets(...)
  busy: boolean
  onPick: (t: MoveTarget) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Move to" onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Move to</h2>
          <span className="text-sm text-brown-muted">Bill {billNo} · an empty table moves it, a table with a bill merges it in</span>
        </div>
        <div className="mt-4 grid flex-1 grid-cols-5 content-start gap-3 overflow-y-auto">
          {targets.map((t) => (
            // a takeaway merge target has tableId null, so key by the bill it merges into
            <button key={t.kind === 'merge' ? t.intoBillId : t.tableId} type="button" disabled={busy || t.kind === 'refused'} onClick={() => onPick(t)}
              title={t.kind === 'refused' ? t.reason : undefined}
              className={`h-24 rounded-xl border-2 p-2 text-left disabled:opacity-40 ${t.kind === 'merge' ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-canvas text-brown-dark'}`}>
              <div className="text-xl font-semibold">{t.label}</div>
              <div className="text-xs">
                {t.kind === 'merge' ? (t.totalSen === null ? `Bill ${t.intoBillNo}` : formatSen(t.totalSen)) : t.kind === 'move' ? 'Empty' : 'Empty · merge only'}
              </div>
            </button>
          ))}
          {targets.length === 0 && <p className="col-span-5 text-sm text-brown-muted">No other table.</p>}
        </div>
        <button type="button" onClick={onClose} disabled={busy} className="mt-4 min-h-12 rounded-xl border border-border-mid text-brown-dark disabled:opacity-40">Cancel</button>
      </div>
    </div>
  )
}
