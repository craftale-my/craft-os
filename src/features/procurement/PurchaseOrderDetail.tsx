import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money, qty, formatPoText, calcShortage } from '../../shared/lib/procurement'
import { PoStatusBadge } from './PurchaseOrders'
import type { PurchaseOrder, PurchaseOrderItem, Receiving, ReceivingItem } from '../../shared/types'

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

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [lines, setLines] = useState<PurchaseOrderItem[]>([])
  const [receiving, setReceiving] = useState<Receiving | null>(null)
  const [receivingLines, setReceivingLines] = useState<ReceivingItem[]>([])
  const [cafeName, setCafeName] = useState('Craft Cafe')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    if (!id) return
    const [poRes, lineRes, recRes, settingsRes] = await Promise.all([
      supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(*), branch:branches(id,name), creator:staff!purchase_orders_created_by_fkey(id,name)')
        .eq('id', id)
        .maybeSingle(),
      supabase.from('purchase_order_items').select('*, item:items(*)').eq('po_id', id),
      supabase.from('receivings').select('*, receiver:staff!receivings_received_by_fkey(id,name)').eq('po_id', id).maybeSingle(),
      supabase.from('company_settings').select('cafe_name').maybeSingle(),
    ])

    if (!poRes.data) { setNotFound(true); setLoading(false); return }
    setPo(poRes.data as PurchaseOrder)
    setLines((lineRes.data as PurchaseOrderItem[]) ?? [])
    setCafeName((settingsRes.data?.cafe_name as string) || 'Craft Cafe')

    const rec = recRes.data as Receiving | null
    setReceiving(rec)
    if (rec) {
      const { data: recLines } = await supabase.from('receiving_items').select('*').eq('receiving_id', rec.id)
      setReceivingLines((recLines as ReceivingItem[]) ?? [])
    }
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

  const receivedById = new Map(receivingLines.map(r => [r.po_item_id, r]))
  const isReceived = po.status === 'received' || po.status === 'partially_received'

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
          {po.status === 'sent' && (
            <>
              <Link
                to={`/procurement/receiving/${po.id}`}
                className="px-4 py-2 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors"
              >
                Receive Goods
              </Link>
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

        <Card title="Order Lines">
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  <th className="px-1 py-2 font-semibold">Item</th>
                  <th className="px-1 py-2 font-semibold text-right">Ordered</th>
                  {isReceived && <th className="px-1 py-2 font-semibold text-right">Received</th>}
                  <th className="px-1 py-2 font-semibold text-right">Unit Price</th>
                  <th className="px-1 py-2 font-semibold text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {lines.map(l => {
                  const rec = receivedById.get(l.id)
                  const shortage = rec ? calcShortage(l.quantity_ordered, rec.actual_quantity) : 0
                  return (
                    <tr key={l.id}>
                      <td className="px-1 py-2.5">
                        <p className="font-medium text-brown-dark">{l.item?.name ?? 'Unknown item'}</p>
                        {l.item?.name_zh && <p className="text-xs text-brown-faint">{l.item.name_zh}</p>}
                      </td>
                      <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-dark">
                        {qty(l.quantity_ordered)} {l.item?.purchase_unit}
                      </td>
                      {isReceived && (
                        <td className="px-1 py-2.5 text-right whitespace-nowrap">
                          {rec ? (
                            <>
                              <span className={shortage > 0 ? 'text-[#9E4A30] font-semibold' : 'text-[#3D7A50] font-semibold'}>
                                {qty(rec.actual_quantity)} {l.item?.purchase_unit}
                              </span>
                              {shortage > 0 && (
                                <p className="text-[10px] text-[#9E4A30]">short {qty(shortage)}</p>
                              )}
                            </>
                          ) : <span className="text-xs text-brown-faint">—</span>}
                        </td>
                      )}
                      <td className="px-1 py-2.5 text-right whitespace-nowrap text-brown-muted">
                        {money(l.unit_price)}
                        {rec && rec.unit_price !== l.unit_price && (
                          <p className={`text-[10px] ${rec.unit_price > l.unit_price ? 'text-[#9E4A30]' : 'text-[#3D7A50]'}`}>
                            invoice {money(rec.unit_price)}
                          </p>
                        )}
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
                  <td className="px-1 py-3 text-xs font-semibold text-brown-muted" colSpan={isReceived ? 4 : 3}>
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

        {receiving && (
          <Card title="Receiving Record">
            <div className="space-y-2 text-sm">
              <p className="text-brown-muted">
                Received by <span className="font-medium text-brown-dark">{receiving.receiver?.name ?? '—'}</span>
                {' on '}
                {new Date(receiving.received_at).toLocaleString('en-GB', {
                  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </p>
              {receiving.has_discrepancy && (
                <p className="text-xs text-[#9E4A30] font-semibold">⚠ This delivery had shortages.</p>
              )}
              {receiving.notes && <p className="text-xs text-brown-muted">{receiving.notes}</p>}
              <div className="flex gap-3 pt-2">
                <a href={receiving.invoice_photo_url} target="_blank" rel="noreferrer">
                  <img
                    src={receiving.invoice_photo_url}
                    alt="invoice"
                    className="w-20 h-20 rounded-lg object-cover border border-[#E8DDD0]"
                  />
                  <p className="text-[10px] text-brown-faint text-center mt-1">Invoice</p>
                </a>
                {receiving.goods_photo_url && (
                  <a href={receiving.goods_photo_url} target="_blank" rel="noreferrer">
                    <img
                      src={receiving.goods_photo_url}
                      alt="goods"
                      className="w-20 h-20 rounded-lg object-cover border border-[#E8DDD0]"
                    />
                    <p className="text-[10px] text-brown-faint text-center mt-1">Goods</p>
                  </a>
                )}
              </div>
            </div>
          </Card>
        )}

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
      </div>
    </div>
  )
}
