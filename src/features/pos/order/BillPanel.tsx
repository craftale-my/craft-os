import { useEffect, useRef, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'
import { computeBill, formatRate } from '../checkout/bill'
import { mergeBills, moveBill, openTable, voidBill, voidItem, type BillingConfig } from '../checkout/checkoutApi'
import ApprovalDialog from '../checkout/ApprovalDialog'
import PickerSheet, { type PickOption } from '../checkout/BillPickers'

type Dialog = { kind: 'void_item'; item: BillItemRow } | { kind: 'void_bill' } | { kind: 'move' } | { kind: 'merge' } | null
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function BillPanel({ branchId, table, bill, refreshKey, billing, moveTargets, mergeSources, onAddItems, onCheckout, onChanged, onMoved }: {
  branchId: string
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  billing: BillingConfig | null   // settings + service-charge rules, for the instant totals
  moveTargets: PickOption[]       // empty tables this bill can move to
  mergeSources: PickOption[]      // other open bills that can be merged into this one
  onAddItems: () => void
  onCheckout: () => void
  onChanged?: () => void | Promise<void>   // after a pause toggle, void, merge or open table; a promise lets a move wait for the reload
  onMoved?: (tableId: string) => void
}) {
  const [items, setItems] = useState<BillItemRow[] | null>(null)   // null = not loaded yet for this bill
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)   // synchronous guard: state alone would let a fast double tap through
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [localKey, setLocalKey] = useState(0)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  useEffect(() => {
    if (!bill) { setItems(null); return }
    let alive = true
    fetchBillItems(bill.id).then((rows) => { if (alive) { setItems(rows); setLoadFailed(false); setError(null) } }, (e) => { if (alive) { setLoadFailed(true); setError(e.message) } })
    return () => { alive = false }
  }, [bill?.id, refreshKey, localKey])
  useEffect(() => { setItems(null); setLoadFailed(false); setError(null); setDialog(null) }, [bill?.id])

  const rows = items ?? []
  const loaded = items !== null && !loadFailed   // only then do we know whether the bill is empty
  const live = rows.filter((i) => !i.voided_at)
  // Instant preview with the same rules as the server (pos_bill_totals); checkout shows the server's numbers.
  const totals = bill && billing ? computeBill({
    orderType: bill.order_type, tableId: bill.table_id,
    sstRegistered: billing.settings.sstRegistered, cashRounding: billing.settings.cashRounding, rules: billing.rules,
    lines: rows.map((i) => ({ productId: i.product_id, unitPriceSen: i.unit_price_sen, qty: i.qty, sstRateBp: i.sst_rate_bp,
                              takeawayFeeSen: i.takeaway_fee_sen, voided: i.voided_at !== null })),
  }) : null
  const orders = [...new Map(rows.map((i) => [i.order_id, i.orders])).entries()]
  const changed = () => { setDialog(null); setLocalKey((k) => k + 1); void onChanged?.() }

  // One bill-level action at a time. `then` runs after the write succeeded and the parent has reloaded.
  const run = async (fn: () => Promise<void>, then?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      try { await fn() } catch (e) { setDialog(null); setError(msg(e)); return }
      setDialog(null); setLocalKey((k) => k + 1)
      await onChanged?.()
      then?.()
    } finally { busyRef.current = false; setBusy(false) }
  }

  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); onChanged?.() } catch (e) { setPaused(!next); setError(msg(e)) }
  }

  const voidWholeBill = () => {
    if (!bill || !loaded || busyRef.current) return
    if (live.length > 0) { setDialog({ kind: 'void_bill' }); return }
    if (!window.confirm(`Close bill ${bill.bill_no}? It has nothing on it.`)) return
    void run(() => voidBill(bill.id, { reason: '', approverId: null, pin: null }))
  }

  const open = () => {
    if (!table || busyRef.current) return
    const answer = window.prompt(`Guests at table ${table.label}?`, '2')
    if (answer === null) return
    const pax = Number(answer)
    if (!Number.isInteger(pax) || pax < 1 || pax > 99) { setError('Enter the number of guests (1–99)'); return }
    void run(async () => { await openTable(table.id, pax) })
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
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
        {bill && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {bill.order_type === 'dine_in' && <button onClick={() => setDialog({ kind: 'move' })} disabled={busy} className="rounded border border-border px-2 py-1 disabled:opacity-40">Move table</button>}
            <button onClick={() => setDialog({ kind: 'merge' })} disabled={busy} className="rounded border border-border px-2 py-1 disabled:opacity-40">Merge with…</button>
            <button onClick={voidWholeBill} disabled={!loaded || busy} className="rounded border border-red-300 px-2 py-1 text-red-700 disabled:opacity-40">{loaded && live.length === 0 ? 'Close empty bill' : 'Void bill'}</button>
          </div>
        )}
        {!bill && table && billing?.settings.qrRequiresOpenBill && (
          <button onClick={open} disabled={busy} className="mt-2 rounded border border-brown-btn px-2 py-1 text-xs disabled:opacity-40">Open table for QR ordering</button>
        )}
      </div>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error} <button className="underline" onClick={() => setError(null)}>OK</button></p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">{o.order_no} · {o.source.toUpperCase()} · {new Date(o.placed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
            {rows.filter((i) => i.order_id === orderId).map((i) => (
              <div key={i.id} className={`flex justify-between py-1 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                <div>
                  {i.qty} × {i.name_snapshot}
                  {i.modifiers_snapshot.map((m, k) => <div key={k} className="pl-4 text-xs text-brown-muted">+ {m.name}</div>)}
                  {i.note && <div className="pl-4 text-xs italic text-brown-muted">* {i.note}</div>}
                </div>
                <div className="text-right">
                  <div>{formatSen(i.unit_price_sen * i.qty)}</div>
                  {!i.voided_at && <button onClick={() => setDialog({ kind: 'void_item', item: i })} className="text-xs text-red-700 underline">Void</button>}
                </div>
              </div>
            ))}
          </div>
        ))}
        {bill && items === null && !error && <p className="text-brown-muted">Loading…</p>}
        {bill && items !== null && items.length === 0 && !error && <p className="text-brown-muted">No items yet.</p>}
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

      {bill && dialog?.kind === 'void_item' && (
        <ApprovalDialog branchId={branchId} action="void_item" title="Void item"
          summary={`${dialog.item.qty} × ${dialog.item.name_snapshot} · ${formatSen(dialog.item.unit_price_sen * dialog.item.qty)} — the kitchen gets a VOID ticket`}
          onApprove={(a) => voidItem(dialog.item.id, a)} onClose={() => setDialog(null)} onDone={changed} />
      )}
      {bill && dialog?.kind === 'void_bill' && (
        <ApprovalDialog branchId={branchId} action="void_bill" title="Void bill"
          summary={`Bill ${bill.bill_no} · ${live.length} item${live.length === 1 ? '' : 's'}${totals ? ` · ${formatSen(totals.totalSen)}` : ''} — every item is voided and the table is freed`}
          onApprove={(a) => voidBill(bill.id, a)} onClose={() => setDialog(null)} onDone={changed} />
      )}
      {bill && dialog?.kind === 'move' && (
        <PickerSheet title={`Move bill ${bill.bill_no}`} hint="Pick an empty table. Nothing is reprinted." options={moveTargets}
          empty="No empty table." onClose={() => setDialog(null)}
          onPick={(tableId) => {
            if (busyRef.current) return
            setDialog(null)
            void run(() => moveBill(bill.id, tableId), () => onMoved?.(tableId))
          }} />
      )}
      {bill && dialog?.kind === 'merge' && (
        <PickerSheet title={`Merge into bill ${bill.bill_no}`} hint="Every order of the bill you pick moves onto this bill, and its table becomes empty."
          options={mergeSources} empty="No other open bill." onClose={() => setDialog(null)}
          onPick={(fromBillId) => {
            if (busyRef.current) return
            const from = mergeSources.find((o) => o.id === fromBillId)
            if (!window.confirm(`Move everything from ${from?.label ?? 'that bill'} onto bill ${bill.bill_no}?`)) return
            setDialog(null)
            void run(() => mergeBills(fromBillId, bill.id))
          }} />
      )}
    </div>
  )
}
