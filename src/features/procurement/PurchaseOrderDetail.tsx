import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import {
  money, qty, formatPoText, outstandingQty, isReceivable, lineOverReceived, canCloseShort, shortfallLines,
} from '../../shared/lib/procurement'
import { useCan } from '../../shared/lib/permissions'
import { PoStatusBadge } from './PurchaseOrders'
import { OverDeliveredBadge } from './badges'
import type { PurchaseOrder, PurchaseOrderItem, Receiving } from '../../shared/types'

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}

function Card({ title, action, children }: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold text-brown-dark">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Receiving photo thumbnail. A broken URL degrades to a same-size placeholder. */
function PhotoThumb({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div>
        <div className="w-20 h-20 rounded-lg border border-dashed border-[#D4C5B0] bg-[#FBF6EE] flex items-center justify-center text-center px-1">
          <span className="text-[10px] text-brown-faint">Photo unavailable</span>
        </div>
        <p className="text-[10px] text-brown-faint text-center mt-1">{label}</p>
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt={label.toLowerCase()}
        onError={() => setFailed(true)}
        className="w-20 h-20 rounded-lg object-cover border border-[#E8DDD0]"
      />
      <p className="text-[10px] text-brown-faint text-center mt-1">{label}</p>
    </a>
  )
}

/** Confirmation dialog for close_po_short: shows what will never arrive and asks why. */
function CloseShortDialog({ lines, onCancel, onConfirm }: {
  lines: PurchaseOrderItem[]
  onCancel: () => void
  onConfirm: (reason: string) => Promise<string | null>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shortfall = shortfallLines(lines)

  async function confirm() {
    if (!reason.trim()) return
    setBusy(true)
    setError('')
    const err = await onConfirm(reason.trim())
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onKeyDown={e => { if (e.key === 'Escape' && !busy) onCancel() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-short-title"
        className="w-full max-w-md bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4 shadow-xl"
      >
        <div>
          <h2 id="close-short-title" className="text-base font-bold text-brown-dark">Close PO short</h2>
          <p className="text-xs text-brown-muted mt-1">
            The order is ended as it stands. Nothing more can be received on it, and stock is not changed.
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold text-brown-medium mb-1">Will never be delivered</p>
          <ul className="text-sm divide-y divide-[#F0E8DC] border border-[#EDE5D8] rounded-lg">
            {shortfall.map(l => (
              <li key={l.id} className="flex justify-between gap-3 px-3 py-2">
                <span className="text-brown-dark">{l.item?.name ?? 'Unknown item'}</span>
                <span className="whitespace-nowrap font-semibold text-[#9E4A30]">
                  {qty(outstandingQty(l))} {l.item?.purchase_unit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label htmlFor="close-short-reason" className="block text-xs font-semibold text-brown-medium mb-1">
            Reason *
          </label>
          <textarea
            id="close-short-reason"
            rows={3}
            autoFocus
            required
            className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark resize-none focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Supplier discontinued the item"
          />
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#F5EDE0] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy || !reason.trim()}
            className="px-4 py-2 rounded-xl bg-[#6B5B4B] text-white text-sm font-semibold hover:bg-[#54473A] transition-colors disabled:opacity-50"
          >
            {busy ? 'Closing…' : 'Close short'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can } = useCan()

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [lines, setLines] = useState<PurchaseOrderItem[]>([])
  // Every delivery against this PO, oldest first.
  const [receivings, setReceivings] = useState<Receiving[]>([])
  const [cafeName, setCafeName] = useState('Craft Cafe')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [closeOpen, setCloseOpen] = useState(false)

  async function load() {
    if (!id) return
    const [poRes, lineRes, recRes, settingsRes] = await Promise.all([
      supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(*), branch:branches(id,name), creator:staff!purchase_orders_created_by_fkey(id,name), closer:staff!purchase_orders_closed_by_fkey(id,name)')
        .eq('id', id)
        .maybeSingle(),
      supabase.from('purchase_order_items').select('*, item:items(*)').eq('po_id', id),
      supabase
        .from('receivings')
        .select('*, receiver:staff!receivings_received_by_fkey(id,name), items:receiving_items(*)')
        .eq('po_id', id)
        .order('received_at', { ascending: true }),
      supabase.from('company_settings').select('cafe_name').maybeSingle(),
    ])

    if (!poRes.data) { setNotFound(true); setLoading(false); return }
    setPo(poRes.data as PurchaseOrder)
    setLines((lineRes.data as PurchaseOrderItem[]) ?? [])
    setCafeName((settingsRes.data?.cafe_name as string) || 'Craft Cafe')
    setReceivings((recRes.data as Receiving[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  async function markSent() {
    if (!po) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase
      .from('purchase_orders')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', po.id)
    setBusy(false)
    if (err) { setError(err.message); return }
    load()
  }

  async function cancelOrder() {
    if (!po) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', po.id)
    setBusy(false)
    if (err) { setError(err.message); return }
    load()
  }

  async function deleteDraft() {
    if (!po) return
    setBusy(true)
    setError('')
    const { error: err } = await supabase.from('purchase_orders').delete().eq('id', po.id)
    setBusy(false)
    if (err) { setError(err.message); return }
    navigate('/procurement/orders')
  }

  /** Returns the error message on failure (shown in the dialog), null on success. */
  async function closeShort(reason: string): Promise<string | null> {
    if (!po) return null
    const { error: err } = await supabase.rpc('close_po_short', { p_po_id: po.id, p_reason: reason })
    if (err) return err.message
    setCloseOpen(false)
    load()
    return null
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy automatically — select the text and copy it manually.')
    }
  }

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (notFound || !po) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Purchase order not found.</p>
          <Link to="/procurement/orders" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Purchase Orders
          </Link>
        </div>
      </div>
    )
  }

  const poText = formatPoText(
    po,
    po.supplier,
    po.branch?.name ?? '—',
    cafeName,
    lines
      .filter(l => l.item)
      .map(l => ({ item: l.item!, quantity_ordered: l.quantity_ordered, unit_price: l.unit_price })),
  )

  const lineById = new Map(lines.map(l => [l.id, l]))
  const isClosedShort = po.status === 'closed_short'
  const isReceived = po.status === 'received' || po.status === 'partially_received' || isClosedShort
  // Supervisors (no manage_procurement) never see Close short.
  const showCloseShort = canCloseShort(po.status, can('manage_procurement'))

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/orders" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Purchase Orders
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-1">
            <div>
              <h1 className="text-2xl font-bold text-brown-dark">{po.po_number}</h1>
              <p className="text-sm text-brown-muted">
                {po.supplier?.name ?? '—'} · {po.branch?.name ?? '—'}
              </p>
            </div>
            <PoStatusBadge status={po.status} />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          {po.status === 'draft' && (
            <>
              <button
                onClick={markSent}
                disabled={busy}
                className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
              >
                {busy ? '…' : 'Mark as Sent'}
              </button>
              <button
                onClick={deleteDraft}
                disabled={busy}
                className="px-4 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors disabled:opacity-50"
              >
                Delete Draft
              </button>
            </>
          )}
          {isReceivable(po.status) && (
            <Link
              to={`/procurement/receiving/${po.id}`}
              className="px-4 py-2 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors"
            >
              {po.status === 'partially_received' ? 'Receive remaining' : 'Receive Goods'}
            </Link>
          )}
          {showCloseShort && (
            <button
              onClick={() => setCloseOpen(true)}
              className="px-4 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#F5EDE0] transition-colors"
            >
              Close short
            </button>
          )}
          {po.status === 'sent' && (
            <>
              <button
                onClick={cancelOrder}
                disabled={busy}
                className="px-4 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors disabled:opacity-50"
              >
                Cancel Order
              </button>
            </>
          )}
        </div>

        {isClosedShort && (
          <section className="rounded-xl border border-[#6B5B4B40] bg-[#6B5B4B10] p-5 space-y-1">
            <h2 className="text-sm font-bold text-[#6B5B4B]">Closed short</h2>
            {po.close_reason && <p className="text-sm text-brown-dark">{po.close_reason}</p>}
            <p className="text-xs text-brown-muted">
              {'Closed by '}
              <span className="font-medium text-brown-dark">{po.closer?.name ?? '—'}</span>
              {po.closed_at && ` · ${new Date(po.closed_at).toLocaleString('en-GB', DATE_TIME)}`}
            </p>
          </section>
        )}

        <Card title="Order Lines">
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  <th className="px-1 py-2 font-semibold">Item</th>
                  <th className="px-1 py-2 font-semibold text-right">Ordered</th>
                  {isReceived && (
                    <>
                      <th className="px-1 py-2 font-semibold text-right">Received so far</th>
                      <th className="px-1 py-2 font-semibold text-right">
                        {isClosedShort ? 'Not delivered' : 'Outstanding'}
                      </th>
                    </>
                  )}
                  <th className="px-1 py-2 font-semibold text-right">Unit Price</th>
                  <th className="px-1 py-2 font-semibold text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {lines.map(l => {
                  // received_quantity is cumulative across every delivery.
                  const outstanding = outstandingQty(l)
                  const over = lineOverReceived(l)
                  return (
                    <tr key={l.id}>
                      <td className="px-1 py-2.5">
                        <p className="font-medium text-brown-dark">{l.item?.name ?? 'Unknown item'}</p>
                      </td>
                      <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                        {qty(l.quantity_ordered)} {l.item?.purchase_unit}
                      </td>
                      {isReceived && (
                        <>
                          <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                            {qty(l.received_quantity)} {l.item?.purchase_unit}
                          </td>
                          <td className="px-1 py-2.5 text-right whitespace-nowrap font-semibold">
                            {over > 0
                              ? <span className="text-[#B46309]">+{qty(over)} over</span>
                              : outstanding > 0
                              ? <span className={isClosedShort ? 'text-[#6B5B4B]' : 'text-[#9E4A30]'}>
                                  {qty(outstanding)} {l.item?.purchase_unit}
                                </span>
                              : <span className="text-[#3D7A50]">✓ 0</span>}
                          </td>
                        </>
                      )}
                      <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-muted">
                        {money(l.unit_price)}
                      </td>
                      <td className="px-1 py-2.5 text-right whitespace-nowrap font-semibold text-brown-dark">
                        {money(l.quantity_ordered * l.unit_price)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-[#EDE5D8]">
                  <td className="px-1 py-3 text-xs font-semibold text-brown-muted" colSpan={isReceived ? 5 : 3}>
                    Order total
                  </td>
                  <td className="px-1 py-3 text-right font-bold text-brown-dark">{money(po.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {po.notes && (
            <p className="text-xs text-brown-muted mt-3 pt-3 border-t border-[#EDE5D8]">
              <span className="font-semibold">Notes:</span> {po.notes}
            </p>
          )}
        </Card>

        {receivings.length > 0 && (
          <Card title="Receiving History">
            <ol className="divide-y divide-[#F0E8DC]">
              {receivings.map((rec, i) => (
                <li key={rec.id} className="py-4 first:pt-0 last:pb-0 space-y-2 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-brown-dark">Delivery {i + 1}</h3>
                    {rec.has_discrepancy && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#9E4A3020] text-[#9E4A30]">
                        Shortage
                      </span>
                    )}
                    {rec.has_over_delivery && <OverDeliveredBadge />}
                  </div>
                  <p className="text-brown-muted">
                    {new Date(rec.received_at).toLocaleString('en-GB', DATE_TIME)}
                    {' · Received by '}
                    <span className="font-medium text-brown-dark">{rec.receiver?.name ?? '—'}</span>
                  </p>
                  {rec.notes && <p className="text-xs text-brown-muted">{rec.notes}</p>}

                  {rec.items && rec.items.length > 0 && (
                    <ul className="text-xs space-y-1">
                      {rec.items.map(ri => {
                        const line = lineById.get(ri.po_item_id)
                        const none = ri.actual_quantity === 0
                        return (
                          <li
                            key={ri.id}
                            className={`flex justify-between gap-3 ${none ? 'text-brown-faint' : 'text-brown-dark'}`}
                          >
                            <span>{line?.item?.name ?? 'Unknown item'}</span>
                            <span className="whitespace-nowrap">
                              {qty(ri.actual_quantity)} {line?.item?.purchase_unit}
                              {!none && (
                                <span
                                  className={
                                    line && ri.unit_price !== line.unit_price
                                      ? ri.unit_price > line.unit_price ? 'text-[#9E4A30] font-semibold' : 'text-[#3D7A50] font-semibold'
                                      : 'text-brown-muted'
                                  }
                                  title={line && ri.unit_price !== line.unit_price ? `Ordered at ${money(line.unit_price)}` : undefined}
                                >
                                  {' · '}{money(ri.unit_price)}
                                </span>
                              )}
                              {Number(ri.over_quantity) > 0 && (
                                <span className="text-[#B46309] font-semibold">
                                  {' · '}+{qty(Number(ri.over_quantity))} extra
                                </span>
                              )}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <div className="flex gap-3 pt-1">
                    <PhotoThumb url={rec.invoice_photo_url} label="Invoice" />
                    {rec.goods_photo_url && <PhotoThumb url={rec.goods_photo_url} label="Goods" />}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {po.status !== 'received' && !isClosedShort && (
          <Card
            title="Send to Supplier"
            action={
              <button
                onClick={() => copyText(poText)}
                className="px-3 py-1.5 text-xs rounded-lg bg-[#25D366] text-white font-semibold hover:bg-[#1FAE53] transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy for WhatsApp'}
              </button>
            }
          >
            <pre className="text-xs text-brown-dark bg-[#FBF6EE] border border-[#EDE5D8] rounded-lg p-4 whitespace-pre-wrap font-body overflow-x-auto">
              {poText}
            </pre>
            {po.supplier?.whatsapp && (
              <p className="text-xs text-brown-faint mt-2">
                Supplier WhatsApp: <span className="font-medium text-brown-muted">{po.supplier.whatsapp}</span>
              </p>
            )}
          </Card>
        )}
      </div>

      {closeOpen && (
        <CloseShortDialog
          lines={lines}
          onCancel={() => setCloseOpen(false)}
          onConfirm={closeShort}
        />
      )}
    </div>
  )
}
