import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import {
  money, qty, formatPoText, outstandingQty, isReceivable, lineOverReceived, canCloseShort, shortfallLines,
  isInternalSupplier, canAccessBranch, inTransitQty, toShipQty, transferValue, shippedUnitCost,
  transferStatusLabel, formatDateTimeMYT, formatUnitCost,
} from '../../shared/lib/procurement'
import { useCan } from '../../shared/lib/permissions'
import { useSignedPhotoUrls } from '../../shared/lib/useSignedPhotoUrls'
import { useAuth } from '../auth/AuthContext'
import { PoStatusBadge } from './PurchaseOrders'
import { OverDeliveredBadge, InternalBadge, TransferStatusBadge } from './badges'
import type { PoShipment, PurchaseOrder, PurchaseOrderItem, Receiving } from '../../shared/types'

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

/**
 * Receiving photo thumbnail. `url` is the signed URL: undefined while signing,
 * null when the photo cannot be shown. A broken URL degrades to the same placeholder.
 */
function PhotoThumb({ url, label }: { url: string | null | undefined; label: string }) {
  const [failed, setFailed] = useState(false)
  if (url === undefined || url === null || failed) {
    return (
      <div>
        <div className="w-20 h-20 rounded-lg border border-dashed border-[#D4C5B0] bg-[#FBF6EE] flex items-center justify-center text-center px-1">
          {url === undefined
            ? <span className="text-[10px] text-brown-faint">Loading…</span>
            : <span className="text-[10px] text-brown-faint">Photo unavailable</span>}
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
  const { staff } = useAuth()
  const location = useLocation()
  // Set by the ship screen after a successful shipment.
  const [toast, setToast] = useState((location.state as { toast?: string } | null)?.toast ?? '')

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  // Internal POs only: every HQ shipment, oldest first.
  const [shipments, setShipments] = useState<PoShipment[]>([])
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
    const order = poRes.data as PurchaseOrder
    // Shipments exist only on internal POs; supplier POs skip the query.
    if (isInternalSupplier(order.supplier)) {
      const { data: shipData } = await supabase
        .from('po_shipments')
        .select('*, shipper:staff!po_shipments_shipped_by_fkey(id,name), items:po_shipment_items(*)')
        .eq('po_id', id)
        .order('shipped_at', { ascending: true })
      setShipments((shipData as PoShipment[]) ?? [])
    } else {
      setShipments([])
    }
    setPo(order)
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

  // One signing call for every receipt photo on the page (private bucket).
  const { urls: photoUrls } = useSignedPhotoUrls(
    receivings.flatMap(r => [r.invoice_photo_url, r.goods_photo_url]),
  )

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

  // ── Internal PO (transfer from HQ) ──
  const internal = isInternalSupplier(po.supplier)
  // HQ staff can read internal POs addressed to them but cannot act on the
  // requesting branch's order — only ship it. Supplier POs are only ever
  // visible to their own branch (RLS), so they are not gated here.
  const ownsPo = !internal || canAccessBranch(staff, po.branch_id)
  const canShip = internal && canAccessBranch(staff, po.supplier?.internal_branch_id)
  const shipmentLinesByPoItem = new Map<string, { qty_shipped: number; unit_cost: number | null }[]>()
  for (const sh of shipments) {
    for (const si of sh.items ?? []) {
      const list = shipmentLinesByPoItem.get(si.po_item_id) ?? []
      list.push({ qty_shipped: Number(si.qty_shipped), unit_cost: si.unit_cost == null ? null : Number(si.unit_cost) })
      shipmentLinesByPoItem.set(si.po_item_id, list)
    }
  }
  const convOf = (l: PurchaseOrderItem) => Number(l.conversion_rate_used ?? l.item?.conversion_rate ?? 0)
  const costOf = (l: PurchaseOrderItem) => shippedUnitCost(shipmentLinesByPoItem.get(l.id) ?? [])
  const lostValueOf = (l: PurchaseOrderItem) =>
    transferValue(Number(l.transit_loss_quantity ?? 0), convOf(l), costOf(l))
  const anyShipped = lines.some(l => Number(l.shipped_quantity ?? 0) > 0)
  const totalInTransit = lines.reduce((s, l) => s + inTransitQty(l), 0)
  const totalToShip = lines.reduce((s, l) => s + toShipQty(l, po.status), 0)
  const totalLost = lines.reduce((s, l) => s + Number(l.transit_loss_quantity ?? 0), 0)
  const totalLostValue = lines.reduce((s, l) => s + (lostValueOf(l) ?? 0), 0)
  const transferLabel = internal ? transferStatusLabel(po.status, lines) : ''

  // Supervisors (no manage_procurement) never see Close short. On an internal
  // PO close_po_short refuses while goods are on the road, so hide it then.
  const showCloseShort = ownsPo && canCloseShort(po.status, can('manage_procurement'))
    && !(internal && totalInTransit > 0)
  // Internal: receive only what HQ has shipped.
  const showReceive = ownsPo && isReceivable(po.status) && (!internal || totalInTransit > 0)
  // A PO with shipped goods cannot be cancelled (DB guard).
  const showCancel = ownsPo && po.status === 'sent' && !(internal && anyShipped)
  const showShip = canShip && totalToShip > 0

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/orders" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Purchase Orders
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-1">
            <div>
              <h1 className="text-2xl font-bold text-brown-dark flex items-center gap-2">
                {po.po_number}
                {internal && <InternalBadge />}
              </h1>
              <p className="text-sm text-brown-muted">
                {po.supplier?.name ?? '—'} · {po.branch?.name ?? '—'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {internal && <TransferStatusBadge label={transferLabel} />}
              <PoStatusBadge status={po.status} />
            </div>
          </div>
        </div>

        {internal && (
          <section className="rounded-xl border border-[#2E6E9E40] bg-[#2E6E9E0D] p-4 space-y-1">
            <h2 className="text-sm font-bold text-[#2E6E9E]">Internal transfer from {po.supplier?.name ?? 'HQ'}</h2>
            <p className="text-xs text-brown-muted">
              HQ ships the goods to {po.branch?.name ?? 'the branch'}; stock moves at HQ's cost when shipped and
              enters the branch when received. Prices on the order are estimates.
            </p>
            {po.delivery_fee != null && (
              <p className="text-xs text-brown-dark">
                Delivery fee: <span className="font-semibold">{money(Number(po.delivery_fee))}</span>
                <span className="text-brown-faint"> · recorded only, not in item cost</span>
              </p>
            )}
            {!ownsPo && (
              <p className="text-xs text-brown-faint">You're viewing this as HQ — only shipping is done from here.</p>
            )}
          </section>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2 flex-wrap items-center">
          {showShip && (
            <Link
              to={`/procurement/transfers/${po.id}/ship`}
              className="px-4 py-2 rounded-xl bg-[#2E6E9E] text-white text-sm font-semibold hover:bg-[#24587F] transition-colors"
            >
              Ship
            </Link>
          )}
          {ownsPo && po.status === 'draft' && (
            <>
              <button
                onClick={markSent}
                disabled={busy}
                className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
              >
                {busy ? '…' : internal ? 'Send to HQ' : 'Mark as Sent'}
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
          {ownsPo && internal && isReceivable(po.status) && totalInTransit === 0 && totalToShip > 0 && (
            <span className="text-xs text-brown-muted">Waiting for HQ to ship.</span>
          )}
          {showReceive && (
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
          {showCancel && (
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

        {internal ? (
          <Card title="Transfer Lines">
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                    <th className="px-1 py-2 font-semibold">Item</th>
                    <th className="px-1 py-2 font-semibold text-right">Ordered</th>
                    <th className="px-1 py-2 font-semibold text-right">Shipped</th>
                    <th className="px-1 py-2 font-semibold text-right">Received</th>
                    <th className="px-1 py-2 font-semibold text-right">In transit</th>
                    <th className="px-1 py-2 font-semibold text-right">Lost in transit</th>
                    <th className="px-1 py-2 font-semibold text-right">Shipped cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E8DC]">
                  {lines.map(l => {
                    const unit = l.item?.purchase_unit ?? ''
                    const inTransit = inTransitQty(l)
                    const lost = Number(l.transit_loss_quantity ?? 0)
                    const lostValue = lostValueOf(l)
                    const cost = costOf(l)
                    return (
                      <tr key={l.id} className={lost > 0 ? 'bg-[#FCF0EC]' : ''}>
                        <td className="px-1 py-2.5">
                          <p className="font-medium text-brown-dark">{l.item?.name ?? 'Unknown item'}</p>
                          <p className="text-[10px] text-brown-faint">Est. {money(l.unit_price)} / {unit}</p>
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                          {qty(l.quantity_ordered)} {unit}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                          {qty(Number(l.shipped_quantity ?? 0))}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                          {qty(Number(l.received_quantity))}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap">
                          {inTransit > 0
                            ? <span className="font-semibold text-[#2E6E9E]">{qty(inTransit)}</span>
                            : <span className="text-brown-faint">0</span>}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap">
                          {lost > 0 ? (
                            <span className="font-bold text-[#9E4A30]">
                              {qty(lost)} {unit}
                              {lostValue != null && <span className="block text-[10px]">{money(lostValue)}</span>}
                            </span>
                          ) : <span className="text-brown-faint">0</span>}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap text-xs text-brown-muted">
                          {formatUnitCost(cost, l.item?.base_unit ?? '')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#EDE5D8]">
                    <td className="px-1 py-3 text-xs font-semibold text-brown-muted" colSpan={6}>
                      Est. order total
                    </td>
                    <td className="px-1 py-3 text-right font-bold text-brown-dark">{money(po.total_amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {totalLost > 0 && (
              <p className="mt-3 text-sm font-bold text-[#9E4A30] bg-[#9E4A3014] border border-[#9E4A3040] rounded-lg px-3 py-2">
                Lost in transit: {money(totalLostValue)}
                <span className="block text-xs font-normal">
                  Valued at the shipped cost. The lost quantity can be re-shipped by HQ, or the order closed short.
                </span>
              </p>
            )}
            {po.notes && (
              <p className="text-xs text-brown-muted mt-3 pt-3 border-t border-[#EDE5D8]">
                <span className="font-semibold">Notes:</span> {po.notes}
              </p>
            )}
          </Card>
        ) : (
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
        )}

        {internal && shipments.length > 0 && (
          <Card title="Shipments from HQ">
            <ol className="divide-y divide-[#F0E8DC]">
              {shipments.map((sh, i) => (
                <li key={sh.id} className="py-4 first:pt-0 last:pb-0 space-y-2 text-sm">
                  <h3 className="font-semibold text-brown-dark">Shipment {i + 1}</h3>
                  <p className="text-brown-muted">
                    {formatDateTimeMYT(sh.shipped_at)}
                    {' · Shipped by '}
                    <span className="font-medium text-brown-dark">{sh.shipper?.name ?? '—'}</span>
                  </p>
                  {sh.notes && <p className="text-xs text-brown-muted">{sh.notes}</p>}
                  <ul className="text-xs space-y-1">
                    {(sh.items ?? []).map(si => {
                      const line = lineById.get(si.po_item_id)
                      const cost = si.unit_cost == null ? null : Number(si.unit_cost)
                      return (
                        <li key={si.id} className="flex justify-between gap-3 text-brown-dark">
                          <span>{line?.item?.name ?? 'Unknown item'}</span>
                          <span className="whitespace-nowrap">
                            {qty(Number(si.quantity))} {line?.item?.purchase_unit}
                            <span className="text-brown-muted">
                              {' · '}{formatUnitCost(cost, line?.item?.base_unit ?? '')}
                              {cost != null && ` · ${money(Number(si.qty_shipped) * cost)}`}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {receivings.length > 0 && (
          <Card title="Receiving History">
            <ol className="divide-y divide-[#F0E8DC]">
              {receivings.map((rec, i) => (
                <li key={rec.id} className="py-4 first:pt-0 last:pb-0 space-y-2 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-brown-dark">Delivery {i + 1}</h3>
                    {internal ? (
                      (rec.items ?? []).some(ri => Number(ri.transit_loss ?? 0) > 0) && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#9E4A3020] text-[#9E4A30]">
                          Lost in transit
                        </span>
                      )
                    ) : rec.has_discrepancy && (
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
                        if (internal) {
                          const lost = Number(ri.transit_loss ?? 0)
                          return (
                            <li key={ri.id} className={`flex justify-between gap-3 ${none ? 'text-brown-faint' : 'text-brown-dark'}`}>
                              <span>{line?.item?.name ?? 'Unknown item'}</span>
                              <span className="whitespace-nowrap">
                                {qty(Number(ri.actual_quantity))} of {qty(Number(ri.expected_quantity))} {line?.item?.purchase_unit}
                                {lost > 0 && (
                                  <span className="text-[#9E4A30] font-semibold">
                                    {' · '}{qty(lost)} lost
                                    {` (${money(lost * Number(ri.unit_price))})`}
                                  </span>
                                )}
                              </span>
                            </li>
                          )
                        }
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
                    <PhotoThumb url={photoUrls[rec.invoice_photo_url]} label={internal ? 'Delivery' : 'Invoice'} />
                    {rec.goods_photo_url && <PhotoThumb url={photoUrls[rec.goods_photo_url]} label="Goods" />}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        )}

        {!internal && po.status !== 'received' && !isClosedShort && (
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

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#3D2410] text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-xl">
          ✅ {toast}
        </div>
      )}

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
