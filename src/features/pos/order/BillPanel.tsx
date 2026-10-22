import { useEffect, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'

export default function BillPanel({ table, bill, refreshKey, onAddItems, onChanged }: {
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  onAddItems: () => void
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

  const subtotal = items.filter((i) => !i.voided_at).reduce((n, i) => n + i.unit_price_sen * i.qty, 0)
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
      <div className="border-t border-border p-3">
        <div className="flex justify-between text-sm"><span>Subtotal</span><b>{formatSen(subtotal)}</b></div>
        <p className="text-xs text-brown-muted">Service charge, SST and checkout come in the next step.</p>
        <button onClick={onAddItems} className="mt-2 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">
          {bill ? 'Add items' : 'New order'}
        </button>
      </div>
    </div>
  )
}
