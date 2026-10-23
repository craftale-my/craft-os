import { useEffect, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'
import { computeBill, formatRate } from '../checkout/bill'
import type { BillingConfig } from '../checkout/checkoutApi'

export default function BillPanel({ table, bill, refreshKey, billing, onAddItems, onCheckout, onChanged }: {
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  billing: BillingConfig | null   // settings + service-charge rules, for the instant totals
  onAddItems: () => void
  onCheckout: () => void
  onChanged?: () => void          // called after a successful pause toggle
}) {
  const [items, setItems] = useState<BillItemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  useEffect(() => {
    if (!bill) { setItems([]); return }
    let alive = true
    fetchBillItems(bill.id).then((rows) => { if (alive) { setItems(rows); setError(null) } }, (e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bill?.id, refreshKey])
  useEffect(() => { setItems([]); setError(null) }, [bill?.id])

  const live = items.filter((i) => !i.voided_at)
  // Instant preview with the same rules as the server (pos_bill_totals); checkout shows the server's numbers.
  const totals = bill && billing ? computeBill({
    orderType: bill.order_type, tableId: bill.table_id,
    sstRegistered: billing.settings.sstRegistered, cashRounding: billing.settings.cashRounding, rules: billing.rules,
    lines: items.map((i) => ({ productId: i.product_id, unitPriceSen: i.unit_price_sen, qty: i.qty, sstRateBp: i.sst_rate_bp,
                               takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null })),
  }) : null
  const orders = [...new Map(items.map((i) => [i.order_id, i.orders])).entries()]

  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); onChanged?.() } catch (e) { setPaused(!next); setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div>
          <div className="text-lg font-semibold">{table ? `Table ${table.label}` : 'Takeaway'}</div>
          <div className="text-xs text-brown-muted">
            {bill ? `Bill ${bill.bill_no}${bill.pax ? ` · ${bill.pax} pax` : ''}` : 'No open bill'}
          </div>
        </div>
        {table && (
          <button onClick={() => void togglePause()} className="rounded border border-border px-3 py-1 text-xs">
            {paused ? 'Resume QR' : 'Pause QR'}
          </button>
        )}
      </div>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">{o.order_no} · {o.source.toUpperCase()} · {new Date(o.placed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
            {items.filter((i) => i.order_id === orderId).map((i) => (
              <div key={i.id} className={`flex justify-between py-1 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                <div>
                  {i.qty} × {i.name_snapshot}
                  {i.modifiers_snapshot.map((m, k) => <div key={k} className="pl-4 text-xs text-brown-muted">+ {m.name}</div>)}
                  {i.note && <div className="pl-4 text-xs italic text-brown-muted">* {i.note}</div>}
                </div>
                <div>{formatSen(i.unit_price_sen * i.qty)}</div>
              </div>
            ))}
          </div>
        ))}
        {bill && items.length === 0 && !error && <p className="text-brown-muted">Loading…</p>}
      </div>
      <div className="border-t border-border p-3 text-sm">
        {totals ? (
          <div className="space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{formatSen(totals.subtotalSen)}</span></div>
            {totals.serviceChargeGroups.map((g) => (
              <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.sstGroups.map((g) => (
              <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span>{formatSen(g.amountSen)}</span></div>
            ))}
            {totals.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span>{formatSen(totals.takeawayFeeSen)}</span></div>}
            {totals.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span>{formatSen(totals.roundingSen)}</span></div>}
            <div className="flex justify-between text-base font-semibold"><span>Total</span><span>{formatSen(totals.totalSen)}</span></div>
          </div>
        ) : (
          <div className="flex justify-between"><span>Subtotal</span><b>{formatSen(live.reduce((n, i) => n + i.unit_price_sen * i.qty, 0))}</b></div>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={onAddItems} className="rounded-xl border border-brown-btn py-3 text-brown-dark">
            {!table ? 'New takeaway order' : bill ? 'Add items' : 'New order'}
          </button>
          <button onClick={onCheckout} disabled={!bill || live.length === 0}
            className="rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Checkout
          </button>
        </div>
      </div>
    </div>
  )
}
