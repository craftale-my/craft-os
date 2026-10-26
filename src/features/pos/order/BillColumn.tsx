// src/features/pos/order/BillColumn.tsx
import { LayoutGrid, Users } from 'lucide-react'
import { formatSen } from './cart'
import { formatRate, type BillTotals } from '../checkout/bill'
import { itemsWord, type BillView, type DraftRow, type SentRow } from './billView'

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })

/** The order screen's bill (spec §2): header with pax and catalog, the sent items grouped by order,
 *  the drafts under an amber rule, the totals preview, and the grid · Send · Payment buttons.
 *  Presentational: OrderScreen owns every action. */
export default function BillColumn(p: {
  title: string                       // "Table T3"
  billNo: string | null               // null = no bill yet
  pax: number | null
  onPax: (() => void) | null          // null = no pax here (takeaway)
  catalogName: string | null
  catalogIsExtra: boolean             // an additional catalog: amber
  onCatalog: (() => void) | null      // null = cannot switch now
  view: BillView
  loading: boolean
  loadError: string | null
  notice: string | null               // e.g. a takeaway bill takes no new items
  onSentTap: (row: SentRow) => void
  onDraftTap: (row: DraftRow) => void
  onActions: () => void
  onSend: () => void
  sendDisabled: boolean
  sending: boolean
  payLabel: string
  payDisabled: boolean
  payHint: string | null
  onPay: () => void
}) {
  const { view } = p
  const orders = [...new Map(view.sent.map((s) => [s.item.order_id, s.item.orders])).entries()]
  return (
    <section aria-label="Bill" className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-card">
      <header className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-lg font-semibold text-brown-dark">{p.title}</h2>
          {p.onPax && (
            <button type="button" onClick={p.onPax} className="flex min-h-11 items-center gap-1 rounded-lg border border-border-mid px-3 text-sm">
              <Users size={16} />{p.pax ?? '—'} pax
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-brown-muted">
          <span>{p.billNo ? `Bill ${p.billNo}` : 'No bill yet'}</span>
          {p.catalogName && (p.onCatalog ? (
            <button type="button" onClick={p.onCatalog}
              className={`min-h-11 rounded-lg border px-3 text-sm ${p.catalogIsExtra ? 'border-amber-500 bg-amber-50 text-amber-800' : 'border-border-mid text-brown-dark'}`}>
              {p.catalogName}
            </button>
          ) : <span className={p.catalogIsExtra ? 'text-amber-700' : ''}>{p.catalogName}</span>)}
          {!p.catalogName && p.onCatalog && (
            <button type="button" onClick={p.onCatalog}
              className="min-h-11 rounded-lg border border-amber-500 bg-amber-50 px-3 text-sm text-amber-800">Choose catalog</button>
          )}
        </div>
      </header>
      {p.notice && <p role="status" className="mx-3 mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{p.notice}</p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {p.loadError && <p role="alert" className="mb-2 rounded bg-red-50 p-2 text-red-700">{p.loadError}</p>}
        {p.loading && <p className="text-brown-muted">Loading…</p>}
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">#{o.order_no} · {o.source === 'qr' ? 'QR' : 'Counter'} · {time(o.placed_at)}</div>
            {view.sent.filter((s) => s.item.order_id === orderId).map((s) => (
              <button key={s.item.id} type="button" disabled={s.voided} onClick={() => p.onSentTap(s)}
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${s.voided ? 'line-through opacity-50' : ''}`}>
                <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} />
                <span className="tabular-nums">{formatSen(s.amountSen)}</span>
              </button>
            ))}
          </div>
        ))}
        {view.drafts.length > 0 && (
          <div className="mt-2 border-l-4 border-amber-400 pl-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">Not sent · {itemsWord(view.draftCount)}</div>
            {view.drafts.map((d) => (
              <button key={d.index} type="button" onClick={() => p.onDraftTap(d)}
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${d.unitSen === null ? 'text-red-700' : ''}`}>
                <LineText qty={d.qty} name={d.name} mods={d.mods} note={d.note} />
                <span className="tabular-nums">{d.unitSen === null ? '—' : formatSen(d.unitSen * d.qty)}</span>
              </button>
            ))}
          </div>
        )}
        {!p.loading && view.sent.length === 0 && view.drafts.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
      </div>
      <footer className="border-t border-border p-3 text-sm">
        {view.totals && <Totals t={view.totals} />}
        {view.drafts.length > 0 && (
          <p className="mt-1 text-xs text-amber-800">{view.totalsIncludeDrafts ? 'Totals include the unsent items.' : 'Unsent items are not in the totals yet.'}</p>
        )}
        <div className="mt-3 grid grid-cols-[56px_1fr_1.4fr] gap-2">
          <button type="button" aria-label="Bill actions" onClick={p.onActions}
            className="flex min-h-14 items-center justify-center rounded-xl border border-border-mid text-brown-dark"><LayoutGrid size={22} /></button>
          <button type="button" onClick={p.onSend} disabled={p.sendDisabled}
            className="min-h-14 rounded-xl border-2 border-brown-btn font-semibold text-brown-btn disabled:opacity-40">{p.sending ? 'Sending…' : 'Send'}</button>
          <button type="button" onClick={p.onPay} disabled={p.payDisabled}
            className="min-h-14 rounded-xl bg-brown-btn font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">{p.payLabel}</button>
        </div>
        {p.payHint && <p className="mt-2 text-center text-xs text-brown-muted">{p.payHint}</p>}
      </footer>
    </section>
  )
}

function LineText({ qty, name, mods, note }: { qty: number; name: string; mods: string[]; note: string | null }) {
  return (
    <span>
      {qty} × {name}
      {mods.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m}</span>)}
      {note && <span className="block pl-4 text-xs italic text-brown-muted">* {note}</span>}
    </span>
  )
}

function Totals({ t }: { t: BillTotals }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{formatSen(t.subtotalSen)}</span></div>
      {t.serviceChargeGroups.map((g) => (
        <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.sstGroups.map((g) => (
        <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span className="tabular-nums">{formatSen(t.takeawayFeeSen)}</span></div>}
      {t.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span className="tabular-nums">{formatSen(t.roundingSen)}</span></div>}
      <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatSen(t.totalSen)}</span></div>
    </div>
  )
}
